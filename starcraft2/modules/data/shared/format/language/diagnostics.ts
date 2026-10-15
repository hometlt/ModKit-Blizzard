/**
 * Pure validation core for GameData XML — no vscode import, so it is unit-testable.
 * Produces `Issue`s (character-offset spans + message/severity); the extension maps
 * them onto `vscode.Diagnostic`s.
 *
 * Everything is driven off `@modkitx/data-processing/sc2-catalog`'s field introspection (which wraps the
 * structure-types schema) and the loaded catalog — no hardcoded field names. Three
 * checks (the high-confidence ones the schema fully supports):
 *   1. unknown field — a child element whose tag isn't a field of the entity's class;
 *   2. bad enum value — a value outside an enum/flags field's member set;
 *   3. unresolved reference — a link field's value that names no existing entity.
 */

import { getAttr, scanXml, type ScannedElement, type ScannedAttr } from './xml-scan.js'
import { catalogEntities } from './entity.js'
import {
  getClassFields,
  hasCatalogClass,
  classifyField,
  lookupField,
  namespaceOfClass,
  catalogClassesForNamespace,
  catalogNamespaceForFileName,
  validateFieldValue,
  type FieldInfo,
} from '../../catalog-engine/sc2-catalog/index.js'
import type { ApplicableCategory } from '../../catalog-engine/sc2-editor-core/index.js'
import { fileExtensions, type EditorCats } from './completion.js'

export type IssueSeverity = 'error' | 'warning'

export interface Issue {
  severity: IssueSeverity
  message: string
  /** Character offsets into the source text. */
  start: number
  end: number
  /** The rule, `sc2-data/<rule>` — what a quick fix or a suppression keys on. */
  code: string
  /** Names valid in this place, for "Did you mean" (fields of the element, enum members). */
  candidates?: readonly string[]
  /** The namespace an unresolved name should be in: a fix offers its ids or creates the entity. */
  namespace?: string
  /** The span whose deletion removes the problem (an unknown attribute with its leading space). */
  removal?: { start: number; end: number }
  /** The name in an unknown field's `</closing>` tag, renamed together with the opening one. */
  closingTag?: { start: number; end: number }
}

/** Does a value name an existing entity? Catalog membership ∪ in-document ids. */
export type CatalogHas = (namespace: string, id: string) => boolean

/**
 * Catalog-backed lookups for the checks that need loaded mod data beyond entity
 * existence. All optional — an omitted callback disables just that check (like
 * `catalogHas`), so schema-only validation still runs with none of these.
 */
export interface DiagnosticRefs {
  /** Is `key` a localized string key defined in the mod? (For text-link fields.) */
  hasString?: (key: string) => boolean
  /**
   * Allowed values for a DEFINED editor category `name`, across the whole merged mod chain
   * (base → deps → mod), or `undefined` if no such category is defined anywhere. This is the
   * authoritative validity source for `EditorCategories` fields — NOT the per-namespace
   * `objectUsage` (which is just editor-dropdown metadata and legitimately omits categories
   * a data file still uses, e.g. `AbilityorEffectType` on an `Abil`). When provided, an
   * unknown category name is a real typo; without it, category names aren't flagged.
   */
  editorCategoryValues?: (name: string) => readonly string[] | undefined
  /**
   * Is `id` a path-scoped catalog constant for `path` defined elsewhere in the mod chain?
   * `<const id="lumber" path="CUnit.ResourceType" value="Custom"/>` lets `ResourceType="lumber"`
   * stand for `Custom`. Constants declared in the validated document are always honored.
   */
  isConstAlias?: (path: string, id: string) => boolean
  /** Whether an entity is a default/template according to the canonical resolved workspace. */
  isDefaultEntity?: (namespace: string, id: string) => boolean | undefined
}

/** Every extension the schema recognizes as an asset (used for wrong-category detection). */
const ALL_ASSET_EXTS = new Set([
  '.dds',
  '.tga',
  '.m3',
  '.m3a',
  '.ogg',
  '.wav',
  '.flac',
  '.mp3',
  '.ogv',
  '.webm',
  '.otf',
  '.ttf',
  '.fnt',
])

const STRUCTURAL_ATTRS = new Set(['index', 'removed', 'id', 'parent', 'class', 'default', 'value'])
/** Attributes that are never schema fields (value aliases / token directives) — exempt
 *  from the unknown-attribute check even when not found in the element's field map. */
const NON_FIELD_ATTRS = new Set(['Link', 'token', 'tokens'])
const MAX_DEPTH = 8

/** Add `path\0id` for every path-scoped `<const id path value/>` outside catalog entities. */
function addConstAliases(elements: ScannedElement[], out: Set<string>): void {
  for (const el of elements) {
    if (el.tag !== 'const') {
      if (!hasCatalogClass(el.tag)) addConstAliases(el.children, out)
      continue
    }
    const id = el.attrs.find(a => a.name === 'id')?.value
    const path = el.attrs.find(a => a.name === 'path')?.value
    if (id && path) out.add(`${path}\u0000${id}`)
  }
}

/**
 * `DiagnosticRefs.isConstAlias` over a set of GameData texts (the loaded mod chain), so a
 * constant declared in a dependency (`warclassic.sc2mod`) resolves in a dependent mod's file.
 */
export function catalogConstAliases(
  texts: Iterable<string>,
): (path: string, id: string) => boolean {
  const aliases = catalogConstAliasKeys(texts)
  return (path, id) => aliases.has(`${path}\u0000${id}`)
}

/**
 * The `<const>` aliases those texts declare, as `path\u0000id` keys: what `catalogConstAliases`
 * checks, kept by a mod server for the whole chain (`data.language` `constAliases`).
 */
export function catalogConstAliasKeys(texts: Iterable<string>): Set<string> {
  const aliases = new Set<string>()
  for (const text of texts) if (text.includes('<const')) addConstAliases(scanXml(text), aliases)
  return aliases
}

/** A value that's templated/token-substituted — don't validate its literal text. */
function isTemplated(value: string): boolean {
  return value.includes('#') || value.includes('$')
}

/** Split on a delimiter, returning each non-empty segment with its start offset. */
function splitWithOffsets(value: string, delim: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  let start = 0
  for (let i = 0; i <= value.length; i++) {
    if (i === value.length || value[i] === delim) {
      if (i > start) out.push({ text: value.slice(start, i), start })
      start = i + 1
    }
  }
  return out
}

/**
 * Split a space-delimited instruction value into positioned tokens, keeping `{…}` brace
 * groups (tuple/list args) as single tokens. E.g. `ModelSwap SomeModel 9` →
 * [ModelSwap, SomeModel, 9]; `AttachSetBearingsFrom {Weapon 0} {} {...}` keeps the braces.
 */
function tokenizeInstruction(value: string): Array<{ text: string; start: number }> {
  const tokens: Array<{ text: string; start: number }> = []
  let i = 0
  while (i < value.length) {
    while (i < value.length && value[i] === ' ') i++
    if (i >= value.length) break
    const start = i
    if (value[i] === '{') {
      let depth = 0
      do {
        if (value[i] === '{') depth++
        else if (value[i] === '}') depth--
        i++
      } while (i < value.length && depth > 0)
    } else {
      while (i < value.length && value[i] !== ' ') i++
    }
    tokens.push({ text: value.slice(start, i), start })
  }
  return tokens
}

/**
 * Validate GameData XML text. `catalogHas` resolves reference existence; when it is
 * omitted (no mod loaded yet) link/reference checks are skipped — unknown-field and
 * enum/flags checks, which need only the schema, still run.
 */
export function collectIssues(
  text: string,
  catalogHas?: CatalogHas,
  editorCats?: EditorCats,
  fileName?: string,
  refs?: DiagnosticRefs,
): Issue[] {
  // The catalog entities (unwrapping the `<Catalog>` root real files use).
  const roots = scanXml(text)
  const entities = catalogEntities(roots)
  const issues: Issue[] = []
  const docConstAliases = new Set<string>()
  addConstAliases(roots, docConstAliases)
  // Catalog class + field chain of the value being checked, for const-alias lookup.
  let currentEntityTag = ''
  const fieldStack: string[] = []
  const isConstAlias = (value: string): boolean => {
    const path = [currentEntityTag, ...fieldStack].join('.')
    return docConstAliases.has(`${path}\u0000${value}`) || !!refs?.isConstAlias?.(path, value)
  }
  // Standard data files (UnitData.xml, ActorData.xml, …) may only hold classes of their own
  // category; custom `<Catalog>` files (unrecognized name) accept any class, so stay lenient.
  const expectedNs = fileName ? expectedNamespaceForFile(fileName) : undefined
  // Applicable editor categories for the entity currently being walked (undefined →
  // no editor data loaded → skip EditorCategories validation, like ref checks).
  let currentEditorCats: ApplicableCategory[] | undefined

  // In-document entity ids (top-level elements) count as resolvable references —
  // so a reference to an entity defined later in the same (possibly unsaved) file
  // isn't falsely flagged.
  const docIds = new Set<string>()
  const isDefaultById = new Map<string, boolean>()
  // Duplicate-id detection: two top-level entities with the same (namespace, id) in ONE
  // file is a copy-paste bug (the later one silently overrides the earlier at load time).
  // Keyed by namespace+id so unrelated namespaces sharing an id don't clash; the FIRST
  // occurrence is the anchor, every later one is flagged. (Cross-FILE same-id is a legal
  // SC2 override, so this is intentionally within-file only.)
  const firstById = new Map<string, ScannedAttr>()
  // In-document parent links per namespace (`ns → id → parentId`), for circular-chain
  // detection. Namespace-keyed (the same id legitimately exists across Abil/Button/…).
  const parentByNsId = new Map<string, Map<string, string>>()
  for (const el of entities) {
    const id = el.attrs.find(a => a.name === 'id')
    if (!id || !id.value) continue
    docIds.add(id.value)
    isDefaultById.set(id.value, isDefaultAttr(el))
    const ns = namespaceOfClass(el.tag)
    const parentAttr = el.attrs.find(a => a.name === 'parent')
    if (ns && parentAttr?.value) {
      let chain = parentByNsId.get(ns)
      if (!chain) {
        chain = new Map()
        parentByNsId.set(ns, chain)
      }
      chain.set(id.value, parentAttr.value)
    }
    const dupKey = `${ns ?? '?'}\u0000${id.value}`
    if (firstById.has(dupKey)) {
      issues.push({
        severity: 'warning',
        code: 'sc2-data/duplicate-id',
        message: `Duplicate id '${id.value}'${ns ? ` in ${ns}` : ''} — this entity overrides the earlier one with the same id`,
        start: id.valueStart,
        end: id.valueEnd,
      })
    } else {
      firstById.set(dupKey, id)
    }
  }
  const resolves = (ns: string, id: string): boolean => docIds.has(id) || !!catalogHas?.(ns, id)

  // `default="1"` entities are templates; their parent must also be a default/template.
  // Checked in-document (template + instances normally live in the same data file).
  const checkDefaultCascade = (el: ScannedElement): void => {
    if (!isDefaultAttr(el)) return
    const parent = el.attrs.find(a => a.name === 'parent')
    if (!parent?.value) return
    const namespace = namespaceOfClass(el.tag)
    const parentDefault =
      isDefaultById.get(parent.value) ??
      (namespace === undefined ? undefined : refs?.isDefaultEntity?.(namespace, parent.value))
    if (parentDefault === false) {
      issues.push({
        severity: 'error',
        code: 'sc2-data/default-parent',
        message: `'default' entity may not inherit from non-default parent '${parent.value}'`,
        start: parent.valueStart,
        end: parent.valueEnd,
      })
    }
  }

  /**
   * Validate a `parent="X"` reference: (1) it must resolve to an existing entity in the same
   * namespace (like a link ref — needs the loaded catalog, so silent while still loading), and
   * (2) the in-document parent chain must not be circular. Skips `parent=""` (a deliberate
   * inheritance reset) and templated values. NB: parents may legitimately be *non-default*
   * entities (concrete bases inherited by variants), so default-ness is NOT required here —
   * only existence + acyclicity. See PLAN_lsp_feature_improvements.md (T1.4 / won't-do note).
   */
  const checkParent = (el: ScannedElement): void => {
    const parent = el.attrs.find(a => a.name === 'parent')
    if (!parent || !parent.value || isTemplated(parent.value)) return
    const ns = namespaceOfClass(el.tag)
    if (!ns) return
    // (1) Existence — same namespace, catalog ∪ in-document; only when the catalog is loaded.
    if (catalogHas && !resolves(ns, parent.value)) {
      issues.push({
        severity: 'warning',
        code: 'sc2-data/unresolved-parent',
        namespace: ns,
        message: `Unresolved parent '${parent.value}' (no such ${ns})`,
        start: parent.valueStart,
        end: parent.valueEnd,
      })
    }
    // (2) Circular chain — walk the in-document parent links (same namespace); cross-file
    // parents terminate the walk (not in the map), so this only fires on real in-doc cycles.
    const selfId = el.attrs.find(a => a.name === 'id')?.value
    const chain = parentByNsId.get(ns)
    if (!selfId || !chain) return
    const seen = new Set<string>([selfId])
    let cur: string | undefined = parent.value
    for (let depth = 0; cur && depth < 64; depth++) {
      if (seen.has(cur)) {
        issues.push({
          severity: 'error',
          code: 'sc2-data/circular-parent',
          message: `Circular parent chain: '${selfId}' eventually inherits from itself (via '${cur}')`,
          start: parent.valueStart,
          end: parent.valueEnd,
        })
        return
      }
      seen.add(cur)
      cur = chain.get(cur)
    }
  }

  const checkValue = (value: string, attr: ScannedAttr, info: FieldInfo): void => {
    if (!value || isTemplated(value)) return

    // Instruction scalars (actor messages/terms, queries, …): a leading keyword picks a
    // typed argument tuple. Validate the keyword + each SIMPLE positional argument
    // (entity/file/enum/number links) against its type; brace-group / `::query` / complex
    // args are left for a later pass. Currently space-delimited only.
    if (info.kind === 'instructions' && info.instructions && info.instructionDelimiter === ' ') {
      if (info.instructionListDelimiter) {
        // A list of instructions (e.g. `;`-separated actor terms): check each segment.
        for (const seg of splitWithOffsets(value, info.instructionListDelimiter)) {
          const segAttr: ScannedAttr = {
            ...attr,
            value: seg.text,
            valueStart: attr.valueStart + seg.start,
            valueEnd: attr.valueStart + seg.start + seg.text.length,
          }
          checkInstruction(seg.text, segAttr, info.instructions, info.instructionFallback)
        }
      } else {
        checkInstruction(value, attr, info.instructions, info.instructionFallback)
      }
      return
    }

    // File/asset fields (CFile, or a CLink to a file): the EXTENSION must fit the field's
    // asset type. Existence is deliberately NOT checked — asset enumeration is capped and
    // CASC base assets may be absent, which would produce false "missing asset" warnings.
    if (info.kind === 'file' || (info.kind === 'link' && info.isFileLink)) {
      checkAssetExtension(value, attr, info)
      return
    }

    if (info.kind === 'link') {
      // Text-link: the value is a localized string key — validate it exists when the
      // loaded locale data is available (`@`-prefixed dynamic refs are skipped).
      if (info.isTextLink) {
        if (refs?.hasString && !value.startsWith('@') && !refs.hasString(value)) {
          issues.push({
            severity: 'warning',
            code: 'sc2-data/unknown-text-key',
            message: `Unknown text key '${value}' (no such localized string)`,
            start: attr.valueStart,
            end: attr.valueEnd,
          })
        }
        return
      }
      // Entity link: reference existence — needs the loaded catalog, so it stays here.
      if (!catalogHas || !info.linkNamespace) return
      if (!resolves(info.linkNamespace, value)) {
        issues.push({
          severity: 'warning',
          code: 'sc2-data/unresolved-reference',
          namespace: info.linkNamespace,
          message: `Unresolved reference '${value}' (no such ${info.linkNamespace})`,
          start: attr.valueStart,
          end: attr.valueEnd,
        })
      }
      return
    }
    // Self-contained value checks (enum/flags/number/bool) — driven by @modkitx/data-processing/sc2-catalog.
    if (info.kind === 'enum' && isConstAlias(value)) return
    let checked = value
    if (info.kind === 'flags' && info.enumMembers) {
      // Report the first flag token that is neither a member nor a path-scoped constant.
      const members = info.enumMembers
      const bad = value
        .split(/[;,]/)
        .map(token => token.replace(/^[+-]/, '').trim())
        .find(
          name => name && !/^-?\d+$/.test(name) && !members.includes(name) && !isConstAlias(name),
        )
      if (bad === undefined) return
      checked = bad
    }
    const issue = validateFieldValue(info, checked)
    if (issue)
      issues.push({
        severity: 'warning',
        code: 'sc2-data/invalid-value',
        // A wrong enum value is replaced whole; a wrong flag is one token of a list, left to the author.
        ...(info.kind === 'enum' && info.enumMembers ? { candidates: info.enumMembers } : {}),
        message: issue.message,
        start: attr.valueStart,
        end: attr.valueEnd,
      })
  }

  /**
   * Validate the REFERENCE arguments (entity link / catalog ref) of a known instruction
   * keyword, so models/units/effects/actors named inside actor messages get existence-
   * checked. Deliberately limited to reference args:
   *
   * The instruction tables are **partial allowlists** — not only is the keyword set a
   * subset of SC2's ~hundreds of messages, the per-arg *types* are approximate too
   * (enum member sets are incomplete, and numeric args carry Bit/UInt bounds that real
   * data routinely exceeds with packed counts and `-1` sentinels). Validating enum/number/
   * bool args against those tables produced heavy false positives on real mods (verified
   * against AR2 ActorData: ~1100 spurious warnings), so only link/catalogRef existence —
   * the high-value, low-false-positive check — is enforced. An UNKNOWN keyword is left
   * alone unless the class declares a link `fallback` (e.g. `CActorKey → CActorLink`),
   * where the whole value is that link. Brace-group / `::query` / complex args are skipped;
   * extra trailing tokens are tolerated (optional/variadic).
   */
  const isRefArg = (k: FieldInfo['kind']): boolean => k === 'link' || k === 'catalogRef'
  const checkInstruction = (
    value: string,
    attr: ScannedAttr,
    instructions: ReadonlyMap<string, FieldInfo[]>,
    fallback?: FieldInfo,
  ): void => {
    const tokens = tokenizeInstruction(value)
    if (tokens.length === 0) return
    const argInfos = instructions.get(tokens[0]!.text)
    if (!argInfos) {
      // Unknown keyword: only actionable when the class falls back to a plain link for
      // the whole value (per-class grammar); otherwise the table is a partial allowlist.
      if (fallback && isRefArg(fallback.kind) && !tokens[0]!.text.startsWith('::'))
        checkValue(value, attr, fallback)
      return
    }
    for (let a = 0; a < argInfos.length && a + 1 < tokens.length; a++) {
      const argInfo = argInfos[a]!
      const tok = tokens[a + 1]!
      // Only reference args; brace-groups, `::query` sub-instructions, and approximate
      // enum/number/bool args are skipped (see above — false-positive avoidance).
      if (tok.text.startsWith('{') || tok.text.startsWith('::') || !isRefArg(argInfo.kind)) continue
      const argAttr: ScannedAttr = {
        ...attr,
        value: tok.text,
        valueStart: attr.valueStart + tok.start,
        valueEnd: attr.valueStart + tok.start + tok.text.length,
      }
      checkValue(tok.text, argAttr, argInfo)
    }
  }

  /**
   * Warn only when the extension is a RECOGNIZED asset extension for the WRONG asset
   * category (e.g. `.dds` in a Model field). Unknown extensions (`.wem`, bare/aliased
   * paths) are left alone, so this never false-positives on legitimate uncommon assets.
   */
  const checkAssetExtension = (value: string, attr: ScannedAttr, info: FieldInfo): void => {
    if (value.startsWith('@')) return // @@Alias — resolved via the merged Assets.txt map
    const dot = value.lastIndexOf('.')
    if (dot < 0) return
    const ext = value.slice(dot).toLowerCase()
    const expected = fileExtensions(info.typeName)
    if (expected.length === 0 || !ALL_ASSET_EXTS.has(ext) || expected.includes(ext)) return
    issues.push({
      severity: 'warning',
      code: 'sc2-data/file-type',
      message: `Unexpected file type '${ext}' — ${info.typeName ?? 'this field'} expects ${expected.join(' / ')}`,
      start: attr.valueStart,
      end: attr.valueEnd,
    })
  }

  /** The scalar value slot of a field element: its `value=` else `Link=` attribute. */
  const valueAttr = (el: ScannedElement): ScannedAttr | undefined =>
    el.attrs.find(a => a.name === 'value') ?? el.attrs.find(a => a.name === 'Link')

  const validate = (el: ScannedElement, schema: Record<string, unknown>, depth: number): void => {
    if (depth > MAX_DEPTH) return

    // Inline attributes that are themselves fields (struct shorthand, e.g. Link=).
    for (const attr of el.attrs) {
      if (STRUCTURAL_ATTRS.has(attr.name)) continue
      const ft = lookupField(schema, attr.name)
      // When the attribute IS a schema field, validate its value — including `Link`
      // (`<WeaponArray Link="X"/>` is a real struct sub-field whose reference must
      // resolve); NON_FIELD_ATTRS only exempts from the unknown-attribute warning.
      if (ft !== undefined) {
        fieldStack.push(attr.name)
        checkValue(attr.value, attr, classifyField(ft))
        fieldStack.pop()
        continue
      }
      if (NON_FIELD_ATTRS.has(attr.name)) continue
      // Unknown attribute on a nested struct element → likely a typo, or a sub-field
      // that should be a child element (attribute-vs-child check). Only at depth > 0:
      // entity (actor/etc.) tags carry loosely-typed engine attributes the structure
      // schema doesn't fully model, so flagging those produces false positives.
      if (depth > 0) {
        // The attribute with the spaces before it and its closing quote.
        let from = attr.nameStart
        while (from > 0 && /\s/u.test(text[from - 1]!)) from -= 1
        const quote = text[attr.valueEnd]
        issues.push({
          severity: 'warning',
          code: 'sc2-data/unknown-attribute',
          removal: { start: from, end: attr.valueEnd + (quote === '"' || quote === "'" ? 1 : 0) },
          message: `Unknown attribute '${attr.name}' — not a field of this element`,
          start: attr.nameStart,
          end: attr.nameEnd,
        })
      }
    }

    for (const child of el.children) {
      const ft = lookupField(schema, child.tag)
      if (ft === undefined) {
        const close = `</${child.tag}>`
        issues.push({
          severity: 'warning',
          code: 'sc2-data/unknown-field',
          candidates: Object.keys(schema),
          ...(text.slice(child.end - close.length, child.end) === close
            ? { closingTag: { start: child.end - close.length + 2, end: child.end - 1 } }
            : {}),
          message: `Unknown field '${child.tag}'`,
          start: child.tagStart,
          end: child.tagEnd,
        })
        continue
      }
      fieldStack.push(child.tag)
      descend(child, classifyField(ft), depth + 1)
      fieldStack.pop()
    }
  }

  const descend = (el: ScannedElement, info: FieldInfo, depth: number): void => {
    switch (info.kind) {
      case 'link':
      case 'enum':
      case 'flags':
      case 'file':
      case 'number':
      case 'bool':
      case 'instructions': {
        const flagIndex = info.kind === 'flags' ? getAttr(el, 'index') : undefined
        if (flagIndex !== undefined) checkValue(flagIndex.value, flagIndex, { ...info, kind: 'enum' })
        const va = valueAttr(el)
        if (va) checkValue(va.value, va, flagIndex === undefined ? info : { kind: 'bool' })
        return
      }
      case 'editorCategories': {
        const va = valueAttr(el)
        if (va) checkEditorCategories(va)
        return
      }
      case 'struct': {
        if (info.nested) validate(el, info.nested, depth)
        return
      }
      case 'array':
      case 'record': {
        const itemInfo = classifyField(info.itemType)
        if (itemInfo.kind === 'struct' && itemInfo.nested) validate(el, itemInfo.nested, depth)
        else descend(el, itemInfo, depth)
        return
      }
      default:
        return
    }
  }

  /**
   * Validate an `EditorCategories` value (`Cat:Val,Cat:Val`). A category is valid when it is
   * DEFINED anywhere in the merged editor data (`refs.editorCategoryValues`), NOT merely when
   * it appears in the namespace's `objectUsage` — that list is editor-dropdown metadata and
   * legitimately omits categories a data file still uses (e.g. the SC2 editor itself writes
   * `AbilityorEffectType:Units` onto `Abil` entities whose `objectUsage` lists only `Race`).
   * The per-namespace applicable subset (`currentEditorCats`) is used only as a fallback value
   * source when the authoritative full map isn't wired — and then category names are NOT
   * flagged (can't distinguish a typo from a valid cross-type category).
   */
  const checkEditorCategories = (attr: ScannedAttr): void => {
    if (!attr.value || isTemplated(attr.value)) return
    const lookup = refs?.editorCategoryValues
    const applicable = new Map((currentEditorCats ?? []).map(c => [c.name, c.values]))
    if (!lookup && applicable.size === 0) return
    let pos = 0
    for (const pair of attr.value.split(',')) {
      const segStart = attr.valueStart + pos
      pos += pair.length + 1 // +1 for the consumed ','
      const colon = pair.indexOf(':')
      if (colon === -1) continue
      const cat = pair.slice(0, colon).trim()
      const catTrimStart = segStart + pair.indexOf(cat)
      const values = lookup ? lookup(cat) : applicable.get(cat)
      if (values === undefined) {
        // Defined nowhere → a real typo, but only assert that when we have the authoritative
        // full category map; the applicable subset alone can't tell a typo from a valid
        // category simply absent from this namespace's editor dropdown.
        if (lookup)
          issues.push({
            severity: 'warning',
            code: 'sc2-data/unknown-editor-category',
            message: `Unknown editor category '${cat}'`,
            start: catTrimStart,
            end: catTrimStart + cat.length,
          })
        continue
      }
      const val = pair.slice(colon + 1).trim()
      if (val && values.length > 0 && !values.includes(val)) {
        const valStart = segStart + colon + 1 + pair.slice(colon + 1).indexOf(val)
        issues.push({
          severity: 'warning',
          code: 'sc2-data/editor-category-value',
          candidates: values,
          message: `Invalid value '${val}' for editor category '${cat}' — expected one of: ${preview(values)}`,
          start: valStart,
          end: valStart + val.length,
        })
      }
    }
  }

  for (const entity of entities) {
    checkDefaultCascade(entity)
    checkParent(entity)
    if (!hasCatalogClass(entity.tag)) continue // unknown/templated class — stay lenient
    const schema = getClassFields(entity.tag)
    if (!schema) continue
    const ns = namespaceOfClass(entity.tag)
    if (expectedNs && ns && ns !== expectedNs) {
      issues.push({
        severity: 'warning',
        code: 'sc2-data/class-namespace',
        message: `'${entity.tag}' is a ${ns} class and does not belong in ${fileName} — expected a ${expectedNs} class`,
        start: entity.tagStart,
        end: entity.tagEnd,
      })
    }
    currentEditorCats = ns ? editorCats?.(ns) : undefined
    currentEntityTag = entity.tag
    validate(entity, schema, 0)
  }

  return issues
}

/**
 * The catalog namespace a standard data file is expected to hold, derived from its name
 * (`UnitData.xml` → `Unit`), or undefined for custom/unknown files. Only namespaces the
 * catalog actually knows (have classes) are enforced, so arbitrary `<Catalog>` files whose
 * name happens to end in `Data.xml` aren't falsely restricted.
 */
const expectedNamespaceForFile = catalogNamespaceForFileName

/** Whether an entity element carries `default="1"` (a default/template entity). */
function isDefaultAttr(el: ScannedElement): boolean {
  const v = el.attrs.find(a => a.name === 'default')?.value
  return v === '1' || v?.toLowerCase() === 'true'
}

function preview(members: readonly string[]): string {
  const head = members.slice(0, 8).join(', ')
  return members.length > 8 ? `${head}, …` : head
}
