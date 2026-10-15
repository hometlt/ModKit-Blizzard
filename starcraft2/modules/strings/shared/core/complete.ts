/**
 * Completion engine for SC2 localized string values, shared by the VS Code raw
 * `.txt` editor (CompletionItemProvider) and the strings-table cell editor
 * (webview autocomplete popup) so both offer the same suggestions.
 *
 * Given the text and a caret offset it decides the context:
 *  - just after `<`            → tag snippets (`<d ref>`, `<c>`, `<n/>`, …)
 *  - inside a tag, at a name   → attribute names for that tag
 *  - inside a ref/stringref/expression value → namespace → entity → field,
 *    re-triggered after each `,` and around the `+ - * / ( )` operators.
 *
 * Browser-safe: pure string logic. Entity/field data comes from the injected
 * `StringCatalog`, so the module has no dependency on the mod loader.
 */

/** Catalog lookups the completion engine needs. All synchronous. */
export interface StringCatalog {
  namespaces(): string[]
  entities(ns: string): string[]
  fields?(ns: string, entity: string): string[]
  /** Property segments already used in localization keys for this catalog (e.g. Name, Tooltip). */
  properties?(ns: string): string[]
  /** Named color constants defined in FontStyles (`<c val="ColorAttackInfo">`). */
  colors?(): string[]
  /** Resolved hex (no `#`) for a named color constant, for a completion-item swatch preview. */
  colorHex?(name: string): string | undefined
  /** Named text styles defined in FontStyles (`<s val="StyleName">`). */
  styles?(): string[]
  /** Asset alias names from the merged `Assets.txt` (`<img path="@@Alias">`). */
  assets?(): string[]
  /** The asset path an alias names, for the item's picture. */
  assetPath?(alias: string): string | undefined
}

export type StringCompletionKind = 'tag' | 'attribute' | 'namespace' | 'entity' | 'field' | 'color' | 'style' | 'asset' | 'enum'

export interface StringCompletion {
  label: string
  insert: string
  /** Caret offset within `insert` after insertion; defaults to end. */
  caret?: number
  detail?: string
  kind: StringCompletionKind
  /** Resolved hex (no `#`) for a `color`-kind item, for a swatch preview. */
  swatch?: string
  /** Show even when it doesn't match the typed prefix (e.g. the leading "Custom Color…"). */
  sticky?: boolean
  /** Asset path an `asset`-kind item names, as the game writes it; the host draws it. */
  asset?: string
}

export interface CompleteContext {
  text: string
  offset: number
  catalog?: StringCatalog
}

export interface CompleteResult {
  items: StringCompletion[]
  /** Number of chars immediately before `offset` that the accepted item replaces. */
  replaceLength: number
}

interface TagSnippet { label: string; insert: string; caret?: number; detail: string }

/**
 * One-line descriptions sourced from https://sc2mapster.wiki.gg/wiki/Text_Tags —
 * shown as completion detail (tag snippets + attribute names) and as hover text
 * over a tag name or attribute name in the raw editor.
 */
const TAG_DOCS: Record<string, string> = {
  d: 'Resolves and displays dynamic data from game catalogs.',
  c: 'Applies colored text using RGB or hexadecimal values.',
  s: 'Applies a named font style to the enclosed text.',
  n: 'Inserts a line break.',
  sp: 'Inserts an invisible whitespace character.',
  h: 'Highlights the following letter (or, wrapped around text, the enclosed text) — typically used for a keyboard shortcut.',
  img: 'Embeds an image or a colored rectangle.',
  k: 'Resolves and displays a hotkey binding with proper formatting.',
  w: 'Prevents text wrapping, forcing the enclosed content onto a single line.',
  lang: 'Applies language-specific pluralization/grammar rules to the enclosed comma-separated options.',
  ul: 'Creates an unordered list container.',
  li: 'Marks an individual list item.',
  a: 'Creates a clickable hyperlink or game-content reference.',
  ignore: 'Strips or ignores formatting tags, to sanitize user input.',
}

/** Attribute descriptions keyed "tag.attr" (lowercase); see {@link TAG_DOCS}. */
const ATTR_DOCS: Record<string, string> = {
  'c.val': 'Color in hexadecimal (RRGGBB[AA]) or decimal (R,G,B[,A]) format, or a named color constant.',
  'c.validator': 'Applies the color only when the named validator condition passes.',
  's.val': 'Name of the text style to apply.',
  's.validator': 'Applies the style only when the named validator condition passes.',
  'img.path': 'File path (or @@Alias) of the texture asset to display.',
  'img.color': 'Colorizes the image, in [A],R,G,B or [AA]RRGGBB format.',
  'img.alignment': 'Vertical alignment: Top, Middle, UpperMiddle, AbsoluteMiddle, or Bottom.',
  'img.height': 'Image height in pixels.',
  'img.width': 'Image width in pixels.',
  'img.texcoords': 'Normalized 0.0-1.0 texture coordinates (top,left,bottom,right) controlling cropping/flipping.',
  'img.resolution': 'Display resolution mode (e.g. "discrete").',
  'img.entrydims': 'Entry dimensions for a texture sheet.',
  'img.texsheet': 'Sprite-sheet grid parameters (columns,rows,index).',
  'img.texanim': 'Sprite-sheet animation parameters (count,duration).',
  'ul.indent': 'Number of spaces to indent list items.',
  'ul.text': 'Character used as the bullet point.',
  'k.val': 'Command button or unit ability to look up the bound hotkey for.',
  'k.count': 'Maximum number of hotkeys to display when multiple are bound.',
  'k.abbreviate': 'Show abbreviated (true) or full (false) hotkey names.',
  'k.pre': 'Text shown immediately before the hotkey.',
  'k.post': 'Text shown immediately after the hotkey.',
  'lang.rule': 'Grammar rule to apply (e.g. "plural") to the enclosed comma-separated options.',
  'a.name': 'Link type: WebsiteUrl, GameContentlink, ChannelName, AchievementId, InviteToParty, PresenceId, or LobbyLink.',
  'a.href': 'Target of the link (URL, user id, chat name, etc.) — meaning depends on name.',
  'ignore.d': 'Whether to "strip" or "ignore" <d> data-reference tags.',
  'ignore.c': 'Whether to "strip" or "ignore" <c> color tags.',
  'ignore.s': 'Whether to "strip" or "ignore" <s> style tags.',
  'ignore.img': 'Whether to "strip" or "ignore" <img> image tags.',
  'd.ref': 'Field reference path using catalog notation (Ns,Entity,Field) or $ functions, evaluated as a numeric expression.',
  'd.stringref': 'Resolves a string property from the catalog (Ns,Entity,Field).',
  'd.player': 'Which player’s data to reference: a player index, "current", or "SelectedUnit".',
  'd.galaxyvar': 'References a Galaxy global variable by name.',
  'd.gamevalue': 'Displays a built-in game state value (MapName, PlayerRace, PlayerName, PlayerColor, PlayerFoodCap, PlayerClanTag).',
  'd.score': 'References a built-in or user-defined score value.',
  'd.unitcount': 'Counts units of the specified type owned by a player.',
  'd.time': 'Displays game time (GameTime, MissionTime, AITime, DateTime, TimeOfDay, or a fixed number of seconds).',
  'd.precision': 'Number of decimal places to display in the numeric output.',
  'd.abilchargecount': 'Returns the charge count for an ability.',
  'd.behaviorstackcount': 'Returns the stack count of a behavior on the selected unit.',
  'd.behaviorremainingduration': 'Returns the remaining duration of a behavior.',
  'd.upgradelevel': 'Returns the upgrade level.',
  'd.upgradeeffectarrayvalue': 'Retrieves an upgrade effect array value by index.',
  'd.accumulatedvalue': 'Calculates an accumulated catalog field value.',
  'd.runaccumulators': 'Evaluates accumulators and returns the result.',
  'd.damage': 'References a damage effect amount.',
  'd.attackdamage': 'References an attack’s damage value.',
}

/** Tag snippets offered right after `<`. `insert` is the text following `<`. */
const TAG_SNIPPETS: TagSnippet[] = [
  { label: 'd ref', insert: 'd ref="" />', caret: 7, detail: TAG_DOCS['d']! },
  { label: 'd stringref', insert: 'd stringref="" />', caret: 13, detail: ATTR_DOCS['d.stringref']! },
  { label: 'd GalaxyVar', insert: 'd GalaxyVar="" />', caret: 13, detail: ATTR_DOCS['d.galaxyvar']! },
  { label: 'c', insert: 'c val=""></c>', caret: 7, detail: TAG_DOCS['c']! },
  { label: 's', insert: 's val=""></s>', caret: 7, detail: TAG_DOCS['s']! },
  { label: 'n', insert: 'n/>', detail: TAG_DOCS['n']! },
  { label: 'sp', insert: 'sp/>', detail: TAG_DOCS['sp']! },
  { label: 'h', insert: 'h/>', detail: TAG_DOCS['h']! },
  { label: 'img', insert: 'img path="" />', caret: 10, detail: TAG_DOCS['img']! },
  { label: 'k', insert: 'k val="" />', caret: 7, detail: TAG_DOCS['k']! },
  { label: 'w', insert: 'w></w>', caret: 2, detail: TAG_DOCS['w']! },
  { label: 'lang', insert: 'lang rule=""></lang>', caret: 11, detail: TAG_DOCS['lang']! },
  { label: 'ul', insert: 'ul><li/></ul>', caret: 3, detail: TAG_DOCS['ul']! },
  { label: 'li', insert: 'li/>', detail: TAG_DOCS['li']! },
  { label: 'a', insert: 'a name="" href=""></a>', caret: 8, detail: TAG_DOCS['a']! },
  { label: 'ignore', insert: 'ignore></ignore>', caret: 7, detail: TAG_DOCS['ignore']! },
]

/** Attribute names offered inside each tag (after the tag name / a space). */
const TAG_ATTRS: Record<string, string[]> = {
  d: [
    'ref', 'stringref', 'GalaxyVar', 'Time', 'precision', 'Player', 'GameValue', 'Score', 'UnitCount',
    'AbilChargeCount', 'BehaviorStackCount', 'BehaviorRemainingDuration', 'UpgradeLevel', 'UpgradeEffectArrayValue',
    'AccumulatedValue', 'RunAccumulators', 'Damage', 'AttackDamage',
  ],
  c: ['val', 'validator'],
  s: ['val', 'validator'],
  img: ['path', 'width', 'height', 'alignment', 'color', 'texcoords', 'resolution', 'entrydims', 'texsheet', 'texanim'],
  k: ['val', 'count', 'abbreviate', 'pre', 'post'],
  ul: ['indent', 'text'],
  lang: ['rule'],
  a: ['name', 'href'],
  ignore: ['d', 'c', 's', 'img'],
}

/** Attributes whose value is a numeric/reference expression (`Ns,Entity,Field` + operators). */
const EXPRESSION_ATTRS = new Set(['ref', 'time', 'gamevalue', 'score', 'unitcount', 'abilchargecount', 'behaviorstackcount', 'upgradelevel', 'upgradeeffectarrayvalue', 'damage', 'attackdamage'])
/** Attributes whose value is a single `Ns,Entity,Field` tuple. */
const TUPLE_ATTRS = new Set(['stringref'])

/** Whether an attribute name's value is a catalog reference (drives value-completion). */
export function isReferenceAttribute(name: string): boolean {
  const n = name.toLowerCase()
  return EXPRESSION_ATTRS.has(n) || TUPLE_ATTRS.has(n)
}

/** Fixed value sets for attributes whose values are a closed enum (keyed "tag.attr"). */
const ENUM_ATTR_VALUES: Record<string, string[]> = {
  'a.name': ['WebsiteUrl', 'GameContentlink', 'ChannelName', 'AchievementId', 'InviteToParty', 'PresenceId', 'LobbyLink'],
  'd.gamevalue': ['MapName', 'PlayerRace', 'PlayerName', 'PlayerColor', 'PlayerFoodCap', 'PlayerClanTag'],
  'img.alignment': ['Top', 'Middle', 'UpperMiddle', 'AbsoluteMiddle', 'Bottom'],
  'k.abbreviate': ['true', 'false'],
  'ignore.d': ['strip', 'ignore'],
  'ignore.c': ['strip', 'ignore'],
  'ignore.s': ['strip', 'ignore'],
  'ignore.img': ['strip', 'ignore'],
}

const EMPTY: CompleteResult = { items: [], replaceLength: 0 }

function tagItem(s: TagSnippet): StringCompletion {
  const item: StringCompletion = { label: s.label, insert: s.insert, detail: s.detail, kind: 'tag' }
  if (s.caret != null) item.caret = s.caret
  return item
}

function byPrefix<T extends { label: string }>(items: T[], prefix: string): T[] {
  const p = prefix.toLowerCase()
  return items.filter((it) => it.label.toLowerCase().startsWith(p))
}

/** Suggest a fixed enum value list for an attribute (e.g. `<a name="">`, `<img alignment="">`). */
function completeEnumValues(values: string[], prefix: string): CompleteResult {
  const replaceLength = prefix.length
  return { items: byPrefix(values.map((v) => ({ label: v })), prefix).map((v) => ({ label: v.label, insert: v.label, kind: 'enum' as const })), replaceLength }
}

/**
 * Suggest names from a flat catalog list (color constants, text styles). For
 * colors, each item gets a resolved hex `swatch` (when known) for a preview in
 * the dropdown, and a "Custom Color…" item always leads — accepting it inserts
 * an editable literal hex, which the color provider immediately decorates with
 * a native swatch/picker (the same one a `<c val="RRGGBB">` value gets).
 */
function completeNamed(names: string[], prefix: string, kind: 'color' | 'style', catalog?: StringCatalog): CompleteResult {
  const replaceLength = prefix.length
  const items: StringCompletion[] = byPrefix(names.map((n) => ({ label: n })), prefix).map((n) => {
    const item: StringCompletion = { label: n.label, insert: n.label, kind }
    if (kind === 'color') {
      const hex = catalog?.colorHex?.(n.label)
      if (hex) item.swatch = hex
    }
    return item
  })
  if (kind === 'color') {
    items.unshift({ label: 'Custom Color…', insert: 'FFFFFFFF', kind: 'color', swatch: 'ffffff', detail: 'Pick a literal color — opens the color picker', sticky: true })
  }
  return { items, replaceLength }
}

/** Suggest `@@Alias` asset references for `<img path="...">` from the merged Assets.txt. */
function completeAssetPath(partial: string, catalog: StringCatalog | undefined): CompleteResult {
  const replaceLength = partial.length
  if (!catalog?.assets) return { items: [], replaceLength }
  const bare = partial.replace(/^@+/, '')
  const items = byPrefix(catalog.assets().map((a) => ({ label: a })), bare)
    .slice(0, 200)
    .map((a): StringCompletion => {
      const path = catalog.assetPath?.(a.label)
      return { label: a.label, insert: `@@${a.label}`, detail: path || 'asset', kind: 'asset', ...(path ? { asset: path } : {}) }
    })
  return { items, replaceLength }
}

/** Suggest ns → entity → field for a partial `Ns,Entity,Field` expression fragment. */
function completeTuple(fragment: string, catalog: StringCatalog | undefined): CompleteResult {
  const parts = fragment.split(',')
  const prefix = parts[parts.length - 1] ?? ''
  const replaceLength = prefix.length
  if (!catalog) return { items: [], replaceLength }
  if (parts.length === 1) {
    return { items: byPrefix(catalog.namespaces().map((n) => ({ label: n })), prefix).map((n) => ({ label: n.label, insert: n.label, kind: 'namespace' as const })), replaceLength }
  }
  if (parts.length === 2) {
    const ns = parts[0]!
    return { items: byPrefix(catalog.entities(ns).map((e) => ({ label: e })), prefix).slice(0, 200).map((e) => ({ label: e.label, insert: e.label, detail: ns, kind: 'entity' as const })), replaceLength }
  }
  if (parts.length === 3 && catalog.fields) {
    const ns = parts[0]!, entity = parts[1]!
    return { items: byPrefix(catalog.fields(ns, entity).map((f) => ({ label: f })), prefix).slice(0, 200).map((f) => ({ label: f.label, insert: f.label, detail: `${ns},${entity}`, kind: 'field' as const })), replaceLength }
  }
  return { items: [], replaceLength }
}

/** The current reference fragment = text after the last operator/paren/space inside an expression. */
function currentExpressionFragment(value: string): string {
  const m = /[^()*/+\-\s]*$/.exec(value)
  return m ? m[0] : ''
}

/**
 * Compute completions for the string value `text` at caret `offset`.
 * Returns an empty result when there is nothing meaningful to suggest.
 */
export function completeStringValue(ctx: CompleteContext): CompleteResult {
  const { text, offset, catalog } = ctx
  const pre = text.slice(0, offset)
  const lastLt = pre.lastIndexOf('<')
  const lastGt = pre.lastIndexOf('>')
  if (lastLt < 0 || lastLt < lastGt) return EMPTY // not inside a tag

  const tagText = pre.slice(lastLt) // e.g. `<d ref="Unit,Mar`

  // Inside a quoted attribute value?
  const inValue = /([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)|'([^']*))$/.exec(tagText)
  if (inValue) {
    const attr = inValue[1]!.toLowerCase()
    const partial = inValue[2] ?? inValue[3] ?? ''
    const tagName = (/^<\/?\s*([A-Za-z][\w]*)/.exec(tagText)?.[1] ?? '').toLowerCase()
    // `val` means different things depending on the tag: a color constant on <c>, a
    // text style on <s>. Raw hex colors aren't offered here (nothing to complete).
    if (tagName === 'c' && attr === 'val') return completeNamed(catalog?.colors?.() ?? [], partial, 'color', catalog)
    if (tagName === 's' && attr === 'val') return completeNamed(catalog?.styles?.() ?? [], partial, 'style')
    if (tagName === 'img' && attr === 'path') return completeAssetPath(partial, catalog)
    // Closed-enum attributes (checked before EXPRESSION_ATTRS: GameValue is technically
    // an expression attribute too, but its common case is one of these fixed keywords).
    const enumValues = ENUM_ATTR_VALUES[`${tagName}.${attr}`]
    if (enumValues) return completeEnumValues(enumValues, partial)
    if (EXPRESSION_ATTRS.has(attr)) return completeTuple(currentExpressionFragment(partial), catalog)
    if (TUPLE_ATTRS.has(attr)) return completeTuple(partial, catalog)
    return EMPTY // other attribute values (rule, …) have no catalog source yet
  }

  // Not inside a value. Are we at the tag name or an attribute-name slot?
  const nameMatch = /^<\/?\s*([A-Za-z][\w]*)?/.exec(tagText)
  const tagName = nameMatch?.[1] ?? ''
  const afterName = tagText.slice(nameMatch?.[0].length ?? 1)
  if (afterName.length === 0 || /^[A-Za-z]*$/.test(tagText.slice(1))) {
    // Still typing the tag name (no whitespace yet): `<`, `<d`, `<im`…
    if (!/\s/.test(tagText)) {
      const prefix = tagText.slice(1)
      return { items: byPrefix(TAG_SNIPPETS, prefix).map(tagItem), replaceLength: prefix.length }
    }
  }
  // Whitespace after the name → attribute-name completion for this tag.
  const attrPrefixMatch = /([A-Za-z_]\w*)?$/.exec(tagText)
  const attrPrefix = attrPrefixMatch?.[1] ?? ''
  const attrs = TAG_ATTRS[tagName.toLowerCase()] ?? []
  const items = byPrefix(attrs.map((a) => ({ label: a })), attrPrefix).map((a) => {
    const item: StringCompletion = { label: a.label, insert: `${a.label}=""`, caret: a.label.length + 2, kind: 'attribute' }
    const doc = ATTR_DOCS[`${tagName.toLowerCase()}.${a.label.toLowerCase()}`]
    if (doc) item.detail = doc
    return item
  })
  return { items, replaceLength: attrPrefix.length }
}

/** A tag name or attribute name's wiki-sourced description, for hover text in the raw editor. */
export interface TagOrAttrDoc { label: string; doc: string; start: number; end: number }

const TAG_OCCURRENCE_RE = /<\/?([A-Za-z][\w]*)\b([^>]*)>/g

/** Find the tag/attribute name at `offset` in `value` and its one-line doc, if any. */
export function findTagOrAttrDocAt(value: string, offset: number): TagOrAttrDoc | undefined {
  TAG_OCCURRENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_OCCURRENCE_RE.exec(value)) !== null) {
    const tagStart = m.index
    const tagEnd = tagStart + m[0].length
    if (offset < tagStart || offset >= tagEnd) continue
    const name = m[1]!
    const nameStart = value.indexOf(name, tagStart)
    const nameEnd = nameStart + name.length
    if (offset >= nameStart && offset < nameEnd) {
      const doc = TAG_DOCS[name.toLowerCase()]
      return doc ? { label: `<${name}>`, doc, start: nameStart, end: nameEnd } : undefined
    }
    const attrsText = m[2]!
    const attrsStart = tagEnd - 1 - attrsText.length // attrsText sits immediately before the tag's closing '>'
    const attrRe = /([A-Za-z_]\w*)\s*=/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(attrsText)) !== null) {
      const attrName = am[1]!
      const aStart = attrsStart + am.index
      const aEnd = aStart + attrName.length
      if (offset >= aStart && offset < aEnd) {
        const doc = ATTR_DOCS[`${name.toLowerCase()}.${attrName.toLowerCase()}`]
        return doc ? { label: attrName, doc, start: aStart, end: aEnd } : undefined
      }
    }
    return undefined
  }
  return undefined
}

export interface KeyCompleteContext {
  /** The key text left of `=` (no leading whitespace, no `=`). */
  text: string
  offset: number
  catalog?: StringCatalog
}

/**
 * Complete a localization key (`Catalog/Property/ObjectId`, the part left of
 * `=`): the first segment from `catalog.namespaces()`, the last segment from
 * `catalog.entities(ns)` once at least two `/` have been typed, and any
 * segment in between from `catalog.properties(ns)`.
 */
export function completeStringKey(ctx: KeyCompleteContext): CompleteResult {
  const { text, offset, catalog } = ctx
  const pre = text.slice(0, offset)
  const lastSlash = pre.lastIndexOf('/')
  const prefix = pre.slice(lastSlash + 1)
  const replaceLength = prefix.length
  if (!catalog) return { items: [], replaceLength }

  const segIdx = pre.split('/').length - 1
  if (segIdx === 0) {
    return { items: byPrefix(catalog.namespaces().map((n) => ({ label: n })), prefix).map((n) => ({ label: n.label, insert: n.label, kind: 'namespace' as const })), replaceLength }
  }

  const ns = text.split('/')[0] ?? ''
  const fullSegCount = text.split('/').length
  const isObjectIdSeg = segIdx >= 2 && segIdx === fullSegCount - 1
  if (isObjectIdSeg) {
    return { items: byPrefix(catalog.entities(ns).map((e) => ({ label: e })), prefix).slice(0, 200).map((e) => ({ label: e.label, insert: e.label, detail: ns, kind: 'entity' as const })), replaceLength }
  }

  const props = catalog.properties?.(ns) ?? []
  return { items: byPrefix(props.map((p) => ({ label: p })), prefix).map((p) => ({ label: p.label, insert: p.label, detail: ns, kind: 'field' as const })), replaceLength }
}
