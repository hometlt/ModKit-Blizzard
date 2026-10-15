/**
 * Pure completion core for GameData XML — no vscode import, so it is unit-testable.
 * Computes, for a cursor offset, either field-name candidates (the entity's schema
 * fields not yet present) or value candidates (enum members, or reference ids for a
 * link field). The extension maps the result onto `vscode.CompletionItem`s.
 *
 * Cursor context comes from the offset-aware `scanXml` tree + a small text probe;
 * field/value typing is classified through `@modkitx/data-processing/sc2-catalog`'s schema introspection.
 */

import {
  elementPathAt,
  attrAt,
  getAttr,
  scanXml,
  type ScannedAttr,
  type ScannedElement,
} from './xml-scan.js'
import { entityPath, catalogEntities } from './entity.js'
import {
  getClassFields,
  classifyField,
  lookupField,
  namespaceOfClass,
  catalogClassesForNamespace,
  catalogClasses,
  catalogStructureDefaultsForNamespace,
  type FieldInfo,
  type SchemaFieldMap,
} from '../../catalog-engine/sc2-catalog/index.js'
import type { ApplicableCategory } from '../../catalog-engine/sc2-editor-core/index.js'

/** Applicable editor categories (objects scope) for a catalog namespace. */
export type EditorCats = (namespace: string) => ApplicableCategory[]

export interface FieldCandidate {
  name: string
  info: FieldInfo
}

export type CompletionResult =
  // `snippet`: insert a full element (vs. just the name). `lead`: prepend `<` to that
  // element (false when the user already typed `<`, so the range stays empty and VS Code
  // shows the whole list instead of filtering it against the `<`).
  | {
      kind: 'fields'
      fields: FieldCandidate[]
      replaceStart: number
      replaceEnd: number
      snippet: boolean
      lead: boolean
    }
  | {
      kind: 'classes'
      classes: string[]
      /** Root structure defaults available only in a typed catalog. */
      structures?: string[]
      replaceStart: number
      replaceEnd: number
      snippet: boolean
      lead: boolean
    }
  | { kind: 'attributes'; attributes: FieldCandidate[]; replaceStart: number; replaceEnd: number }
  | {
      kind: 'values'
      values: string[]
      info: FieldInfo
      replaceStart: number
      replaceEnd: number
      /** The cursor follows an unquoted `=`; accepting a value must insert its quotes too. */
      quote?: boolean
      /** Labels to surface first + mark (e.g. `default="1"` template entities for `parent`). */
      preferred?: readonly string[]
    }
  | { kind: 'assets'; extensions: string[]; replaceStart: number; replaceEnd: number }
  | { kind: 'none' }

/** Field kinds written as a single attribute value (vs. nested child elements). */
const SCALAR_KINDS = new Set<FieldInfo['kind']>([
  'link',
  'catalogRef',
  'enum',
  'flags',
  'number',
  'bool',
  'file',
  'scalar',
])

/**
 * Attribute names valid on an element of type `info`: a struct's scalar sub-fields
 * (single-value → attribute, e.g. `<LaunchAssets Model="" Sound=""/>`), a scalar
 * field's `value`, and `index` for array/record items. Array/struct sub-fields are
 * NOT attributes — they're child elements.
 */
function attributeCandidates(info: FieldInfo): FieldCandidate[] {
  const out: FieldCandidate[] = []
  const nested =
    info.kind === 'struct'
      ? info.nested
      : info.kind === 'array' || info.kind === 'record'
        ? classifyField(info.itemType).nested
        : undefined
  if (nested) {
    for (const [name, ft] of Object.entries(nested)) {
      const fi = classifyField(ft)
      if (SCALAR_KINDS.has(fi.kind)) out.push({ name, info: fi })
    }
  } else if (SCALAR_KINDS.has(info.kind)) {
    out.push({ name: 'value', info })
  }
  if (info.kind === 'array' || info.kind === 'record')
    out.push({
      name: 'index',
      info: info.kind === 'record' ? classifyField(info.indexType) : { kind: 'scalar' },
    })
  if (info.kind === 'flags') out.push({ name: 'index', info: { ...info, kind: 'enum' } })
  return out
}

/** Asset file extensions a file-typed field expects, by its structure-type name. */
export function fileExtensions(typeName: string | undefined): string[] {
  const n = (typeName ?? '').toLowerCase()
  if (n.includes('image') || n.includes('texture')) return ['.dds', '.tga']
  if (n.includes('model')) return ['.m3']
  if (n.includes('anim') || n.includes('facial')) return ['.m3a', '.m3']
  if (n.includes('sound')) return ['.ogg', '.wav', '.flac', '.mp3']
  if (n.includes('movie') || n.includes('cutscene')) return ['.ogv', '.webm']
  if (n.includes('font')) return ['.otf', '.ttf', '.fnt']
  return [] // unknown CFile → caller offers all assets
}

/** Resolve reference-target ids for a link namespace (catalog-provided). */
export type LinkIds = (namespace: string) => string[]

/** Token names declared on a parent entity (for token-instance attribute completion). */
export type EntityTokens = (namespace: string, parentId: string) => string[]

/** Default/template entity ids in a namespace, supplied by the canonical workspace model. */
export type DefaultTemplates = (namespace: string) => readonly string[]

function matchingPrefix<Value extends { readonly name: string }>(
  values: readonly Value[],
  prefix: string,
): Value[] {
  const wanted = prefix.trim().toLowerCase()
  return wanted.length === 0
    ? [...values]
    : values.filter(value => value.name.toLowerCase().startsWith(wanted))
}

function matchingValuePrefix(values: readonly string[], prefix: string): string[] {
  const wanted = prefix.trim().toLowerCase()
  return wanted.length === 0
    ? [...values]
    : values.filter(value => value.toLowerCase().startsWith(wanted))
}

/** Explicit catalog classification supplied by the host-facing Data provider. */
export type CatalogRootContext =
  { readonly kind: 'typed'; readonly namespace: string } | { readonly kind: 'untyped' }

/**
 * Attribute candidates on a catalog entity's own open tag: `id`, `parent` (link to the
 * namespace), `default` (only meaningful on a parented/templated entity), and any tokens
 * declared by its parent template.
 */
function entityAttributes(
  entity: ScannedElement,
  present: Set<string>,
  tokens?: EntityTokens,
): FieldCandidate[] {
  const ns = namespaceOfClass(entity.tag)
  const parentId = entity.attrs.find(a => a.name === 'parent')?.value
  const out: FieldCandidate[] = [
    { name: 'id', info: { kind: 'scalar' } },
    { name: 'parent', info: ns ? { kind: 'link', linkNamespace: ns } : { kind: 'scalar' } },
  ]
  // `default` cascades from a default parent — only relevant once a parent is set.
  if (parentId) out.push({ name: 'default', info: { kind: 'bool' } })
  if (parentId && ns && tokens) {
    for (const tk of tokens(ns, parentId))
      if (!present.has(tk)) out.push({ name: tk, info: { kind: 'scalar' } })
  }
  return out
}

/** Field map valid for the *children* of the element at the end of `path`. */
export function schemaForPath(path: ScannedElement[]): SchemaFieldMap | undefined {
  if (path.length === 0) return undefined
  let schema = getClassFields(path[0]!.tag)
  for (let i = 1; i < path.length && schema; i++) {
    schema = nestedSchema(classifyField(lookupField(schema, path[i]!.tag)))
  }
  return schema
}

/** The struct field map reachable through a field's type, if any. */
function nestedSchema(info: FieldInfo): SchemaFieldMap | undefined {
  if (info.kind === 'struct') return info.nested
  if (info.kind === 'array' || info.kind === 'record') {
    const item = classifyField(info.itemType)
    return item.kind === 'struct' ? item.nested : undefined
  }
  return undefined
}

/** The type of attribute `attrName` on a field element of type `info`. */
export function attrType(info: FieldInfo, attrName: string): FieldInfo | undefined {
  if (attrName === 'index' && info.kind === 'flags') return { ...info, kind: 'enum' }
  if (attrName === 'index' && (info.kind === 'array' || info.kind === 'record')) {
    return info.kind === 'record' ? classifyField(info.indexType) : { kind: 'scalar' }
  }
  if (attrName === 'value' || attrName === 'Link') {
    if (info.kind === 'enum' || info.kind === 'flags' || info.kind === 'link') return info
    if (info.kind === 'array' || info.kind === 'record') {
      const item = classifyField(info.itemType)
      if (item.kind === 'enum' || item.kind === 'flags' || item.kind === 'link') return item
      if (item.kind === 'struct') return classifyField(lookupField(item.nested!, attrName))
    }
    if (info.kind === 'struct') return classifyField(lookupField(info.nested!, attrName))
    return undefined
  }
  const nested = nestedSchema(info)
  return nested ? classifyField(lookupField(nested, attrName)) : undefined
}

function valuesFor(info: FieldInfo, linkIds: LinkIds | undefined): string[] | undefined {
  if (info.kind === 'enum' || info.kind === 'flags')
    return info.enumMembers ? [...info.enumMembers] : undefined
  if (
    info.kind === 'link' &&
    !info.isTextLink &&
    !info.isFileLink &&
    info.linkNamespace &&
    linkIds
  ) {
    return linkIds(info.linkNamespace)
  }
  if (info.kind === 'bool') return ['0', '1']
  return undefined
}

function delimitedValueCompletion(
  info: FieldInfo,
  attr: ScannedAttr,
  offset: number,
  linkIds: LinkIds | undefined,
): Extract<CompletionResult, { kind: 'values' }> | undefined {
  const cursor = Math.max(0, Math.min(offset - attr.valueStart, attr.value.length))
  if (info.kind === 'flags' && info.enumMembers !== undefined) {
    const before = attr.value.slice(0, cursor)
    const after = attr.value.slice(cursor)
    const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(';')) + 1
    const nextComma = after.search(/[,;]/u)
    const end = nextComma === -1 ? attr.value.length : cursor + nextComma
    const raw = attr.value.slice(start, end)
    const leading = /^\s*[+-]?/u.exec(raw)?.[0].length ?? 0
    const trailing = /\s*$/u.exec(raw)?.[0].length ?? 0
    const used = new Set(
      attr.value
        .split(/[,;]/u)
        .filter((_, index, all) => index !== attr.value.slice(0, start).split(/[,;]/u).length - 1)
        .map(value => value.replace(/^[\s+-]+/u, '').trim())
        .filter(Boolean),
    )
    return {
      kind: 'values',
      values: info.enumMembers.filter(value => !used.has(value)),
      info,
      replaceStart: attr.valueStart + start + leading,
      replaceEnd: attr.valueStart + Math.max(start + leading, end - trailing),
    }
  }
  if (info.kind === 'instructions' && info.instructions !== undefined) {
    const outer = info.instructionListDelimiter
    const before = attr.value.slice(0, cursor)
    const segmentStart = outer === undefined ? 0 : before.lastIndexOf(outer) + 1
    const after = attr.value.slice(cursor)
    const nextOuter = outer === undefined ? -1 : after.indexOf(outer)
    const segmentEnd = nextOuter === -1 ? attr.value.length : cursor + nextOuter
    const segment = attr.value.slice(segmentStart, segmentEnd)
    const delimiter = info.instructionDelimiter ?? ' '
    const firstDelimiter = segment.indexOf(delimiter)
    if (firstDelimiter === -1 || cursor - segmentStart <= firstDelimiter) {
      return {
        kind: 'values',
        values: [...info.instructions.keys()],
        info,
        replaceStart: attr.valueStart + segmentStart,
        replaceEnd:
          attr.valueStart + (firstDelimiter === -1 ? segmentEnd : segmentStart + firstDelimiter),
      }
    }
    const keyword = segment.slice(0, firstDelimiter)
    const args = info.instructions.get(keyword)
    if (args === undefined) return undefined
    const relative = cursor - segmentStart
    const beforeArgument = segment.slice(firstDelimiter + delimiter.length, relative)
    const argumentIndex = beforeArgument.split(delimiter).length - 1
    const argumentInfo = args[argumentIndex]
    const values = argumentInfo === undefined ? undefined : valuesFor(argumentInfo, linkIds)
    if (argumentInfo === undefined || values === undefined) return undefined
    const previous = segment.lastIndexOf(delimiter, relative - 1)
    const next = segment.indexOf(delimiter, relative)
    return {
      kind: 'values',
      values,
      info: argumentInfo,
      replaceStart: attr.valueStart + segmentStart + previous + delimiter.length,
      replaceEnd: attr.valueStart + segmentStart + (next === -1 ? segment.length : next),
    }
  }
  return undefined
}

function unquotedAssignmentAt(
  text: string,
  element: ScannedElement,
  offset: number,
): { readonly name: string; readonly start: number } | undefined {
  if (offset <= element.tagEnd || offset > element.openEnd ||
      (offset === element.openEnd && text[offset - 1] === '>')) return undefined
  const before = text.slice(element.tagEnd, offset)
  const match = /(?:^|\s)([A-Za-z_][A-Za-z0-9_:.-]*)\s*=\s*$/u.exec(before)
  if (match?.[1] === undefined) return undefined
  return { name: match[1], start: offset }
}

function assignmentType(path: ScannedElement[], name: string): FieldInfo | undefined {
  if (path.length === 1) {
    if (name === 'parent') {
      const namespace = namespaceOfClass(path[0]!.tag)
      return namespace === undefined ? undefined : { kind: 'link', linkNamespace: namespace }
    }
    if (name === 'default') return { kind: 'bool' }
    return undefined
  }
  const schema = schemaForPath(path.slice(0, -1))
  const type = schema === undefined ? undefined : lookupField(schema, path.at(-1)!.tag)
  if (type === undefined) return undefined
  const info = classifyField(type)
  return info.kind === 'flags' && name === 'value' && getAttr(path.at(-1)!, 'index') !== undefined
    ? { kind: 'bool' } : attrType(info, name)
}

export function computeCompletions(
  text: string,
  offset: number,
  linkIds?: LinkIds,
  editorCats?: EditorCats,
  entityTokens?: EntityTokens,
  rootContext?: CatalogRootContext,
  defaultTemplates?: DefaultTemplates,
): CompletionResult {
  const raw = elementPathAt(text, offset)
  const path = entityPath(raw)
  // Not inside a catalog entity → we're at the `<Catalog>` root (or top level): offer the
  // entity classes valid for this file's namespace (e.g. CUnit / CTerrain) + `const`.
  if (path.length === 0) return rootClassCompletion(text, offset, raw, rootContext)

  const deepest = path[path.length - 1]!

  // ── parent="…" completion: entity ids in the same namespace ──
  const attr = attrAt(deepest, offset)
  if (attr && attr.name === 'parent') {
    const ns = namespaceOfClass(path[0]!.tag)
    if (!ns) return { kind: 'none' }
    // Catalog ids (loaded mod) ∪ ids defined in the current document. Default/template
    // entities (`default="1"`) are the intended inheritance targets, so surface them
    // first — computed from the in-document declarations (templates + instances usually
    // live in the same file).
    const ids = new Set(linkIds?.(ns) ?? [])
    const preferred = new Set(defaultTemplates?.(ns) ?? [])
    for (const e of catalogEntities(scanXml(text))) {
      if (namespaceOfClass(e.tag) !== ns) continue
      const id = getAttr(e, 'id')?.value
      if (!id) continue
      ids.add(id)
      const def = getAttr(e, 'default')?.value
      if (def === '1' || def?.toLowerCase() === 'true') preferred.add(id)
    }
    return ids.size > 0
      ? {
          kind: 'values',
          values: [...ids],
          info: { kind: 'link', linkNamespace: ns },
          replaceStart: attr.valueStart,
          replaceEnd: attr.valueEnd,
          ...(preferred.size > 0 ? { preferred: [...preferred] } : {}),
        }
      : { kind: 'none' }
  }

  if (attr && path.length === 1) {
    const info = assignmentType(path, attr.name)
    const values = info === undefined ? undefined : valuesFor(info, linkIds)
    if (info !== undefined && values !== undefined) {
      const cursor = Math.max(0, Math.min(offset - attr.valueStart, attr.value.length))
      return {
        kind: 'values',
        values: matchingValuePrefix(values, attr.value.slice(0, cursor)),
        info,
        replaceStart: attr.valueStart,
        replaceEnd: attr.valueEnd,
      }
    }
  }

  // ── value completion: cursor inside an attribute value of a field element ──
  if (attr && path.length >= 2) {
    const parentSchema = schemaForPath(path.slice(0, -1))
    if (parentSchema) {
      const ft = lookupField(parentSchema, deepest.tag)
      if (ft !== undefined) {
        const fieldInfo = classifyField(ft)
        // EditorCategories field (`ObjectType:Unit,Race:Terr`) — its `value` is a
        // comma-separated K:V string, completed against the editor categories.
        // File field (image/model/sound/…) — offer asset paths from the dependency chain.
        if (
          (fieldInfo.kind === 'file' ||
            (fieldInfo.kind === 'link' && fieldInfo.isFileLink === true)) &&
          (attr.name === 'value' || attr.name === 'Link')
        ) {
          return {
            kind: 'assets',
            extensions: fileExtensions(fieldInfo.typeName),
            replaceStart: attr.valueStart,
            replaceEnd: attr.valueEnd,
          }
        }
        if (fieldInfo.kind === 'editorCategories' && attr.name === 'value' && editorCats) {
          const ns = namespaceOfClass(path[0]!.tag)
          const ec = editorCategoryCompletion(
            attr.value,
            attr.valueStart,
            offset,
            ns ? editorCats(ns) : [],
          )
          return ec
            ? {
                kind: 'values',
                values: ec.values,
                info: fieldInfo,
                replaceStart: ec.start,
                replaceEnd: ec.end,
              }
            : { kind: 'none' }
        }
        const info = fieldInfo.kind === 'flags' && attr.name === 'value' && getAttr(deepest, 'index') !== undefined
          ? { kind: 'bool' as const } : attrType(fieldInfo, attr.name)
        const delimited = info && delimitedValueCompletion(info, attr, offset, linkIds)
        if (delimited !== undefined) return delimited
        const values = info && valuesFor(info, linkIds)
        if (info && values) {
          const cursor = Math.max(0, Math.min(offset - attr.valueStart, attr.value.length))
          return {
            kind: 'values',
            values: matchingValuePrefix(values, attr.value.slice(0, cursor)),
            info,
            replaceStart: attr.valueStart,
            replaceEnd: attr.valueEnd,
          }
        }
      }
    }
    return { kind: 'none' }
  }

  // `name=|`: offer typed values immediately and include the missing quotes in the accepted item.
  const assignment = attr === undefined ? unquotedAssignmentAt(text, deepest, offset) : undefined
  if (assignment !== undefined) {
    const info = assignmentType(path, assignment.name)
    const values = info === undefined ? undefined : valuesFor(info, linkIds)
    if (info !== undefined && values !== undefined) {
      return {
        kind: 'values',
        values,
        info,
        replaceStart: assignment.start,
        replaceEnd: offset,
        quote: true,
      }
    }
  }

  // ── field-name completion ─────────────────────────────────────────────────
  const typingName = offset >= deepest.tagStart && offset <= deepest.tagEnd
  if (typingName) {
    // Typing the element name: candidates are fields of the *parent* container.
    if (path.length < 2) return { kind: 'none' } // top-level (entity class) — not completed
    const parent = path[path.length - 2]!
    const schema = schemaForPath(path.slice(0, -1))
    if (!schema) return { kind: 'none' }
    const present = childTags(parent, deepest)
    return {
      kind: 'fields',
      fields: matchingPrefix(
        candidateFields(schema, present),
        text.slice(deepest.tagStart, offset),
      ),
      replaceStart: deepest.tagStart,
      replaceEnd: deepest.tagEnd,
      snippet: false, // replacing a typed name fragment — insert the name only
      lead: false,
    }
  }

  // Inside the open tag, past the tag name (attribute area): offer attribute *names*
  // (a struct's scalar sub-fields, a scalar field's `value`, an array item's `index`)
  // rather than `<Field>` element snippets (which produced `<CardLayouts C<Layout…>`).
  if (offset > deepest.tagEnd && (offset < deepest.openEnd ||
      (offset === deepest.openEnd && text[offset - 1] !== '>'))) {
    const present = new Set(deepest.attrs.map(a => a.name))
    // Replace any partial attribute name already typed before the cursor.
    let s = offset
    while (s > deepest.tagEnd && /[A-Za-z0-9_]/.test(text[s - 1] ?? '')) s--

    // Entity open tag (the catalog class itself): structural attrs id/parent/default + tokens.
    if (path.length < 2) {
      const attributes = matchingPrefix(
        entityAttributes(deepest, present, entityTokens).filter(c => !present.has(c.name)),
        text.slice(s, offset),
      )
      return attributes.length
        ? { kind: 'attributes', attributes, replaceStart: s, replaceEnd: offset }
        : { kind: 'none' }
    }

    const parentSchema = schemaForPath(path.slice(0, -1))
    const ft = parentSchema ? lookupField(parentSchema, deepest.tag) : undefined
    if (ft === undefined) return { kind: 'none' }
    const attributes = matchingPrefix(
      attributeCandidates(classifyField(ft)).filter(c => !present.has(c.name)),
      text.slice(s, offset),
    )
    if (attributes.length === 0) return { kind: 'none' }
    return { kind: 'attributes', attributes, replaceStart: s, replaceEnd: offset }
  }

  // Cursor in element content: candidates are fields of the containing element.
  const schema = schemaForPath(path)
  if (!schema) return { kind: 'none' }
  const present = childTags(deepest, undefined)
  // Keep any just-typed `<` outside the replace range (empty range → VS Code shows the
  // whole field list instead of filtering it against `<`), and don't double the `<`.
  const afterLt = text[offset - 1] === '<'
  return {
    kind: 'fields',
    fields: candidateFields(schema, present),
    replaceStart: offset,
    replaceEnd: offset,
    snippet: true, // content position — insert a full `<Field …/>` element
    lead: !afterLt, // prepend `<` only when the user hasn't typed one
  }
}

/**
 * Root-level completion (direct child of `<Catalog>`, or top level): the catalog entity
 * classes for this file's namespace + `const`. The namespace is inferred from the entities
 * already in the document (e.g. an existing `<CTerrain>` → the Terrain catalog).
 */
function rootClassCompletion(
  text: string,
  offset: number,
  raw: ScannedElement[],
  context?: CatalogRootContext,
): CompletionResult {
  const container = raw[raw.length - 1]
  // Only complete at the catalog root: directly inside <Catalog>, while typing an element
  // name whose parent is <Catalog>, or at the very top level (no wrapper — tests/snippets).
  const typingName = !!container && offset >= container.tagStart && offset <= container.tagEnd
  const parent = typingName ? raw[raw.length - 2] : container
  const atDocumentRoot = parent === undefined
  const atCatalogRoot = parent?.tag.toLowerCase() === 'catalog'
  if (!atDocumentRoot && !atCatalogRoot) return { kind: 'none' }

  // A GameData XML document has exactly one legal document element. Catalog classes and constants
  // become valid only after the cursor is inside that wrapper.
  if (atDocumentRoot) {
    const textualName = /<([A-Za-z_][A-Za-z0-9_:.-]*)$/u.exec(text.slice(0, offset))?.[1]
    const prefix =
      typingName && container ? text.slice(container.tagStart, offset) : (textualName ?? '')
    const replacingName = prefix.length > 0
    return {
      kind: 'classes',
      classes: matchingValuePrefix(['Catalog'], prefix),
      replaceStart: typingName && container ? container.tagStart : offset - prefix.length,
      replaceEnd: typingName && container ? container.tagEnd : offset,
      snippet: !replacingName,
      lead: text[offset - 1] !== '<',
    }
  }

  const ns = context?.kind === 'typed' ? context.namespace : firstNamespace(text)
  const classes =
    context?.kind === 'untyped'
      ? catalogClasses()
      : ns === undefined
        ? []
        : [...catalogClassesForNamespace(ns)].sort()
  const structures =
    context?.kind === 'typed' ? catalogStructureDefaultsForNamespace(context.namespace) : undefined
  classes.push('const')
  if (classes.length === 1 && structures?.length === 0) return { kind: 'none' }

  if (typingName && container) {
    const prefix = text.slice(container.tagStart, offset)
    // Replacing the partial element name the user is typing → insert the class name only.
    return {
      kind: 'classes',
      classes: matchingValuePrefix(classes, prefix),
      ...(structures === undefined ? {} : { structures: matchingValuePrefix(structures, prefix) }),
      replaceStart: container.tagStart,
      replaceEnd: container.tagEnd,
      snippet: false,
      lead: false,
    }
  }
  // Content position: insert a full `<Class …>` element. Keep any just-typed `<` outside
  // the range so the class list shows on `<` (and isn't filtered against it).
  const afterLt = text[offset - 1] === '<'
  return {
    kind: 'classes',
    classes,
    ...(structures === undefined ? {} : { structures }),
    replaceStart: offset,
    replaceEnd: offset,
    snippet: true,
    lead: !afterLt,
  }
}

/** Namespace of the first catalog entity in the document, if any. */
function firstNamespace(text: string): string | undefined {
  for (const e of catalogEntities(scanXml(text))) {
    const ns = namespaceOfClass(e.tag)
    if (ns) return ns
  }
  return undefined
}

/**
 * Completion inside an `EditorCategories` value (`ObjectType:Unit,Race:Terr`): on the
 * key side of the current `,`-separated segment offer applicable category names; after
 * a `:` offer that category's values. Returns the candidate list + the range to replace.
 */
function editorCategoryCompletion(
  value: string,
  valueStart: number,
  offset: number,
  cats: ApplicableCategory[],
): { values: string[]; start: number; end: number } | undefined {
  const cursor = Math.max(0, Math.min(offset - valueStart, value.length))
  const segStart = value.lastIndexOf(',', cursor - 1) + 1
  const segEndIdx = value.indexOf(',', cursor)
  const segEnd = segEndIdx === -1 ? value.length : segEndIdx
  const colon = value.slice(segStart, segEnd).indexOf(':')
  const inKey = colon === -1 || cursor - segStart <= colon

  if (inKey) {
    const keyEnd = colon === -1 ? segEnd : segStart + colon
    return { values: cats.map(c => c.name), start: valueStart + segStart, end: valueStart + keyEnd }
  }
  const category = value.slice(segStart, segStart + colon).trim()
  const cat = cats.find(c => c.name === category)
  return {
    values: cat?.values ?? [],
    start: valueStart + segStart + colon + 1,
    end: valueStart + segEnd,
  }
}

function childTags(el: ScannedElement, exclude: ScannedElement | undefined): Set<string> {
  const tags = new Set<string>()
  for (const c of el.children) if (c !== exclude) tags.add(c.tag)
  return tags
}

/**
 * The CClass meta-fields that are attributes/instructions on the entity tag, not
 * child field elements — never offered as `<Field>` completions.
 */
const META_FIELDS = new Set(['default', 'class', 'id', 'parent', 'token', 'tokens'])

/** Schema fields not already present (arrays/records repeat, so they stay offered). */
function candidateFields(schema: SchemaFieldMap, present: Set<string>): FieldCandidate[] {
  const out: FieldCandidate[] = []
  for (const [name, ft] of Object.entries(schema)) {
    if (META_FIELDS.has(name)) continue
    const info = classifyField(ft)
    const repeatable = info.kind === 'array' || info.kind === 'record' || info.kind === 'flags'
    if (!repeatable && present.has(name)) continue
    out.push({ name, info })
  }
  return out
}

/** Snippet body for a field candidate, shared by every editor adapter. */
export function fieldElementBody(field: FieldCandidate): string {
  switch (field.info.kind) {
    case 'struct':
      return `${field.name}>\n\t$0\n</${field.name}>`
    case 'array':
    case 'record':
      // SC2 accepts `value` as the generic array-item slot even when the item expands
      // to a struct. MK2 always emitted both controls, which also lets users clear or
      // override a whole indexed entry before choosing its structure attributes.
      return `${field.name} index="$1" value="$0"/>`
    default:
      return `${field.name} value="$0"/>`
  }
}

/** Snippet body for a catalog-root declaration. */
export function rootElementBody(name: string, structure: boolean): string {
  if (name === 'Catalog') return 'Catalog>\n\t$0\n</Catalog>'
  if (name === 'const') return 'const id="$1" value="$0"/>'
  return structure ? `${name}>\n\t$0\n</${name}>` : `${name} id="$1">\n\t$0\n</${name}>`
}
