/**
 * Entity card assembler — `buildEntityCard` produces a fully-resolved, renderer-
 * agnostic card for one catalog entity (Unit, Weapon, Abil, …). See
 * docs/tasks-complete/entity-cards-strings/ENTITY_CARD_MODEL.md and COMMAND_CARD_ASSEMBLY.md.
 *
 * Strings are resolved + rendered to HTML via `@modkitx/strings`; entity references
 * (weapons/abilities/actors/sounds) come from the relation graph so we don't re-walk
 * the schema. The graph is passed via a minimal structural interface to avoid a hard
 * dependency on `@modkitx/ops`.
 */

import type { Sc2WikiSource } from './source.js'
import { resolveStringValue, type CatalogResolver } from '../../../../strings/shared/core/resolve.js'
import { renderMarkupHtml } from '../../../../strings/shared/core/render-html.js'
import { textRunsOf, type PreviewTextRun } from '../../../../layout/shared/preview-text.js'
import { DATA_CLASS_SCHEMA, CLink } from '../../catalog-engine/sc2-schema/index.js'
import { coerceEntity } from './wiki.js'
import { deriveActorModel } from './visuals.js'

interface RefLike {
  to: { namespace: string; id: string }
  path: string
}
export interface CardProducerRef {
  kind: string
  category: string
  creator: { namespace: string; id: string }
  path: string
  routes: Array<{
    producer: { namespace: string; id: string }
    chain: Array<{
      from: { namespace: string; id: string }
      to: { namespace: string; id: string }
      path: string
    }>
  }>
  triggers: Array<{
    file: string
    library?: string
    triggerId: string
    triggerName?: string
    functionCallId?: string
    functionDef?: { library?: string; id: string }
    initiates: { namespace: string; id: string }
  }>
}
export interface CardGraph {
  outgoing(ns: string, id: string): RefLike[]
  incoming(ns: string, id: string): RefLike[]
  unitProducers?(id: string): CardProducerRef[]
}

export interface CardContext {
  mod: Sc2WikiSource
  /** Locale code for string resolution, e.g. `enUS`. */
  locale: string
  /** Relation graph (from `@modkitx/ops` `buildRelations`); optional. */
  graph?: CardGraph
}

export interface CardLink {
  ns: string
  id: string
  label: string
  /** Declaration site of the linked entity (mod load-order path + file), for "go to source". */
  src?: { mod: string; file: string; line?: number }
}
export interface CardField {
  name: string
  value: string
  ref?: CardLink
  /** Target catalog namespace when the schema types this field as an entity link (combobox editing). */
  linkNs?: string
  /** True for plain scalar/link fields the surgical patcher can edit (`<Name value="…"/>` form). */
  editable?: boolean
}
export interface CardCost {
  minerals?: number
  vespene?: number
  energy?: number
  life?: number
  time?: number
}
export interface CardButton {
  id: string
  row: number
  col: number
  /** `AbilCmd` | `Submenu` | `CancelSubmenu` | `Passive` | … */
  type: string
  face: string
  iconAsset?: string
  hotkey?: string
  nameHtml: string
  tooltipHtml: string
  abil?: string
  /** Card page a `Submenu` button opens. */
  submenuCardId?: string
  cost?: CardCost
  cooldown?: number
  range?: number
  /** Build/train/research time from the ability command, in seconds. */
  time?: number
  /** Allowed target filters (noise like Dead/Hidden stripped), for the tooltip. */
  targets?: string
  /** What a train/build/research command produces (navigable). */
  produces?: CardLink
}
/** One command-card page (`CardLayouts CardId="…"`; the unnamed layout is `Root`). */
export interface CommandCardPage {
  id: string
  buttons: CardButton[]
}
export interface CardWeapon extends CardLink {
  iconAsset?: string
  descriptionHtml?: string
  range?: number
  /** Seconds between attacks. */
  period?: number
  damage?: number
  /** Bonus damage vs an attribute (e.g. +10 vs Armored), from the damage effect. */
  bonuses?: Array<{ attribute: string; amount: number }>
  /** Hits per attack (`DisplayAttackCount`), when > 1. */
  attacks?: number
  /** Computed damage-per-second (damage × attacks / period). */
  dps?: number
  targets?: string
}
export interface CardSound {
  id: string
  label: string
  files: string[]
}
export interface CardVital {
  name: string
  max: number
  start?: number
  armor?: number
  armorIcon?: string
  regen?: number
}
/** One namespace's worth of relations (either direction), for the relations tree. */
export interface CardRelGroup {
  ns: string
  total: number
  links: CardLink[]
}

export interface CardProducerRoute {
  producer: CardLink
  /** Ordered catalog nodes between the producer and produced Unit. */
  via: CardLink[]
}

export interface CardTriggerProducer {
  file: string
  library?: string
  triggerId: string
  triggerName?: string
  functionCallId?: string
  functionDef?: { library?: string; id: string }
  initiates: CardLink
}

export interface CardProducer {
  kind: string
  category: string
  creator: CardLink
  path: string
  routes: CardProducerRoute[]
  triggers: CardTriggerProducer[]
}

export interface EntityCard {
  ns: string
  id: string
  className: string
  /** Resolved display name (plain text). */
  name: string
  /** Resolved description as HTML (styles + computed values + inline `<img>`). */
  descriptionHtml?: string
  /** The same description as styled runs (colour, emphasis, inline icons) for a generic card. */
  descriptionRuns?: PreviewTextRun[]
  /** Icon asset path (`Assets\…` or `@@UI/…`), decoded by the view. */
  iconAsset?: string
  /** Model `.m3`/`.mdx` asset path for the embedded preview, when resolvable. */
  modelAsset?: string
  cost?: { minerals?: number; vespene?: number; supply?: number; time?: number }
  vitals: CardVital[]
  attributes: string[]
  /** Curated schema fields as a labelled table; link fields carry `ref`. */
  fields: CardField[]
  /** Command-card pages, `Root` first; submenu buttons link pages by id. */
  commandCards: CommandCardPage[]
  weapons: CardWeapon[]
  abilities: CardLink[]
  behaviors: CardLink[]
  /** Resolved Unit production mechanisms, owning Units, chains, and trigger roots. */
  producers: CardProducer[]
  sounds: CardSound[]
  /** Outgoing relations grouped by namespace (what this entity uses). */
  relationsOut: CardRelGroup[]
  /** Incoming relations grouped by namespace (what uses this entity). */
  relationsIn: CardRelGroup[]
  /** All locales available in the mod (for the locale switch). */
  locales: string[]
  /** Where the entity is declared (mod load-order path + file), for write-back / provenance. */
  source?: { mod: string; file: string; line?: number }
  /** Every declaration/patch site in load order (declared in liberty, modified in swarm/void, …). */
  sources?: Array<{ mod: string; file: string; line?: number }>
}

// ─── string resolution ───────────────────────────────────────────────────────

function makeResolver(mod: Sc2WikiSource, locale: string): CatalogResolver {
  const loc = mod.locales.get(locale.toLowerCase())
  const getString = (key: string, preferredFiles?: readonly string[]): string | undefined => {
    if (!loc) return undefined
    for (const fileName of preferredFiles ?? []) {
      const v = loc.get(fileName)?.get(key)
      if (v !== undefined) return v
    }
    for (const file of loc.values()) {
      const v = file.get(key)
      if (v !== undefined) return v
    }
    return undefined
  }
  return {
    getResolved: (ns, id) => mod.getResolved(ns, id) as Record<string, unknown> | undefined,
    getTextConstant: name => mod.getTextConstant(name, locale),
    getTextStyle: name => mod.getTextStyle(name, locale),
    getString,
  }
}

function plain(mod: Sc2WikiSource, resolver: CatalogResolver, key: string): string {
  const raw = resolver.getString?.(key)
  return raw ? resolveStringValue(raw, resolver).rendered : ''
}
function html(mod: Sc2WikiSource, resolver: CatalogResolver, key: string): string | undefined {
  return styled(resolver, key)?.html
}
/** A string as the wiki's HTML and as the runs a generic card draws, from one resolution. */
function styled(resolver: CatalogResolver, key: string): { html: string; runs: PreviewTextRun[] } | undefined {
  const raw = resolver.getString?.(key)
  if (!raw) return undefined
  const segments = resolveStringValue(raw, resolver).segments
  return { html: renderMarkupHtml(segments), runs: textRunsOf(segments) }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
/** Number from a scalar or a `{ value }` wrapper (accumulated fields like damage Amount). */
const scalarNum = (v: unknown): number | undefined => num(v) ?? num(obj(v)?.['value'])

function linkLabel(mod: Sc2WikiSource, resolver: CatalogResolver, ns: string, id: string): CardLink {
  const name = plain(mod, resolver, `${ns}/Name/${id}`)
  const link: CardLink = { ns, id, label: name || id }
  const src = mod.get(ns, id)?.source
  if (src)
    link.src = {
      mod: src.mod,
      file: src.file,
      ...(src.line !== undefined ? { line: src.line } : {}),
    }
  return link
}

/** Flag-noise stripped, allowed-only target filters as a display string ("Ground, Visible"). */
const TARGET_NOISE = new Set(['Dead', 'Hidden', 'Invulnerable', 'Stasis', 'Missile', 'Self'])
function targetFilterText(v: unknown): string | undefined {
  // A target-filter string is "allowed;excluded" CSVs. The coerced flags object keys each
  // semicolon segment in insertion order, so the FIRST entry is the allowed segment.
  let allowedCsv: string | undefined
  if (typeof v === 'string') allowedCsv = v.split(';')[0]
  else {
    const o = obj(v)
    if (!o) return undefined
    allowedCsv = Object.entries(o).find(([, on]) => on === true)?.[0]
  }
  if (!allowedCsv) return undefined
  const allowed = allowedCsv
    .split(',')
    .map(s => s.trim())
    .filter(tok => tok && !tok.startsWith('-') && !TARGET_NOISE.has(tok))
  return allowed.length ? allowed.join(', ') : undefined
}

// ─── command card (Spec 3) ───────────────────────────────────────────────────

function buildCommandCards(mod: Sc2WikiSource, resolver: CatalogResolver, u: Obj): CommandCardPage[] {
  const pages = new Map<string, CardButton[]>()
  const layouts = u['CardLayouts']
  if (!Array.isArray(layouts)) return []
  for (const layout of layouts as Obj[]) {
    const cardId = str(layout['CardId']) ?? 'Root'
    const buttons = layout['LayoutButtons']
    if (!Array.isArray(buttons)) continue
    for (const b of buttons as Obj[]) {
      const face = str(b['Face'])
      if (!face) continue
      const btn = mod.get('Button', face)
      const bc = btn ? (coerceEntity(btn, mod) as Obj) : {}
      const abilCmd = str(b['AbilCmd'])
      const info = abilCmd ? abilCommandInfo(mod, resolver, abilCmd) : {}
      // Text keys come from the Button's own fields first (they carry `##id##`-substituted
      // keys like `Button/Tooltip/Probe`), the conventional pattern second.
      const button: CardButton = {
        id: face,
        row: num(b['Row']) ?? 0,
        col: num(b['Column']) ?? 0,
        type: str(b['Type']) ?? 'AbilCmd',
        face,
        nameHtml: html(mod, resolver, keyOf(bc['Name']) ?? `Button/Name/${face}`) ?? face,
        tooltipHtml: html(mod, resolver, keyOf(bc['Tooltip']) ?? `Button/Tooltip/${face}`) ?? '',
      }
      const icon = str(bc['Icon'])
      if (icon) button.iconAsset = icon
      const abilId = abilCmd ? abilCmd.split(',')[0] : undefined
      if (abilId) button.abil = abilId
      const submenu = str(b['SubmenuCardId'])
      if (submenu) button.submenuCardId = submenu
      const hk = resolver.getString?.(keyOf(bc['Hotkey']) ?? `Button/Hotkey/${face}`)
      if (hk) button.hotkey = hk
      if (info.cost) button.cost = info.cost
      if (info.cooldown !== undefined) button.cooldown = info.cooldown
      if (info.range !== undefined) button.range = info.range
      if (info.time !== undefined) button.time = info.time
      if (info.targets) button.targets = info.targets
      if (info.produces) button.produces = info.produces
      const slot = pages.get(cardId) ?? []
      slot.push(button)
      pages.set(cardId, slot)
    }
  }
  // Root (the unnamed layout) first, then submenu pages in encounter order.
  return [...pages]
    .sort(([a], [b]) => (a === 'Root' ? -1 : b === 'Root' ? 1 : 0))
    .map(([id, buttons]) => ({ id, buttons }))
}

interface AbilCmdInfo {
  cost?: CardCost
  cooldown?: number
  range?: number
  time?: number
  targets?: string
  produces?: CardLink
}

/**
 * Cost / cooldown / range / time / product for a command-card button, resolved from its
 * ability (`AbilCmd = "abil,Command"`). Looks up the command's own entry in `InfoArray`
 * (train/build/research/morph) or `Cost` (effect abilities) by command name, falling
 * back to the first entry. See COMMAND_CARD_ASSEMBLY.md.
 */
function abilCommandInfo(mod: Sc2WikiSource, resolver: CatalogResolver, abilCmd: string): AbilCmdInfo {
  const [abilId, cmdName] = abilCmd.split(',').map(s => s.trim())
  if (!abilId) return {}
  const abil = mod.get('Abil', abilId)
  if (!abil) return {}
  const a = coerceEntity(abil, mod) as Obj
  const out: AbilCmdInfo = {}

  // Command-indexed entry: InfoArray for train/build/research/morph abilities. Only the command's
  // own entry: `Halt` or `Cancel` of a build ability have none, and the first one is another building.
  const infoEntry = commandEntry(a['InfoArray'], cmdName)
  // Cost: either on the InfoArray entry (`Resource`/`Vital`/`Time`) or in the Cost array.
  const costEntry =
    obj(infoEntry?.['Cost']) ?? indexedEntry(a['Cost'], cmdName) ?? firstEntry(a['Cost'])
  const costSource = { ...(costEntry ?? {}), ...(infoEntry ?? {}) }

  const cost: CardCost = {}
  const res = obj(costSource['Resource'])
  if (res) {
    const m = num(res['Minerals'])
    if (m) cost.minerals = m
    const v = num(res['Vespene'])
    if (v) cost.vespene = v
  }
  const vit = obj(costSource['Vital'])
  if (vit) {
    const e = num(vit['Energy'])
    if (e) cost.energy = e
    const l = num(vit['Life'])
    if (l) cost.life = l
  }
  if (Object.keys(cost).length) out.cost = cost

  const cd = obj(costSource['Cooldown'])
  const tu = cd ? num(cd['TimeUse']) : undefined
  if (tu !== undefined) out.cooldown = tu
  const time = num(infoEntry?.['Time']) ?? num(costSource['Time'])
  if (time !== undefined) out.time = time

  const range = num(a['Range']) ?? num(infoEntry?.['Range'])
  if (range !== undefined) out.range = range
  const targets = targetFilterText(firstValue(a['TargetFilters']))
  if (targets) out.targets = targets

  // What the command produces (train/build → Unit, research → Upgrade), for icon/navigation.
  const unit =
    str(infoEntry?.['Unit']) ??
    (Array.isArray(infoEntry?.['Unit']) ? str((infoEntry?.['Unit'] as unknown[])[0]) : undefined)
  const upgrade = str(infoEntry?.['Upgrade'])
  if (unit) out.produces = linkLabel(mod, resolver, 'Unit', unit)
  else if (upgrade) out.produces = linkLabel(mod, resolver, 'Upgrade', upgrade)
  // Train and build entries name the unit, not the price: the button costs what the unit costs.
  if (out.cost === undefined && unit) {
    const produced = mod.get('Unit', unit)
    const price = obj(produced ? (coerceEntity(produced, mod) as Obj)['CostResource'] : undefined)
    const minerals = num(price?.['Minerals'])
    const vespene = num(price?.['Vespene'])
    if (minerals || vespene) out.cost = { ...(minerals ? { minerals } : {}), ...(vespene ? { vespene } : {}) }
  }
  return out
}

/**
 * The entry of command `Build3`/`Train1`/`Research2` in an ability's InfoArray: the one indexed by
 * that name, or the entry at its number when the array is positional. A command without an entry
 * (`Halt`, `Cancel`, `Execute`) gets none.
 */
function commandEntry(v: unknown, command: string | undefined): Obj | undefined {
  if (command === undefined) return undefined
  if (!Array.isArray(v)) {
    const o = obj(v)
    const match = o && Object.entries(o).find(([k, val]) => k.toLowerCase() === command.toLowerCase() && obj(val))
    return match ? (match[1] as Obj) : undefined
  }
  const items = v.filter((x): x is Obj => obj(x) !== undefined)
  const named = items.find(x => String(x['index'] ?? '').toLowerCase() === command.toLowerCase())
  if (named) return named
  const number = /(\d+)$/u.exec(command)?.[1]
  return number === undefined || items.some(x => x['index'] !== undefined) ? undefined : items[Number(number) - 1]
}

/**
 * Find a command's entry in an indexed collection: either an array of `{index: 'Train1', …}`
 * items or (post-coercion) a word-keyed map `{ Train1: {…} }`. Case-insensitive; falls back
 * to the first entry.
 */
function indexedEntry(v: unknown, key: string | undefined): Obj | undefined {
  if (Array.isArray(v)) {
    const items = v.filter((x): x is Obj => obj(x) !== undefined)
    if (key) {
      const match = items.find(x => String(x['index'] ?? '').toLowerCase() === key.toLowerCase())
      if (match) return match
    }
    return items[0]
  }
  const o = obj(v)
  if (!o) return undefined
  if ('index' in o || 'value' in o) return o
  const entries = Object.entries(o).filter(([, val]) => obj(val) !== undefined)
  if (key) {
    const match = entries.find(([k]) => k.toLowerCase() === key.toLowerCase())
    if (match) return match[1] as Obj
  }
  return entries[0]?.[1] as Obj | undefined
}
function firstEntry(v: unknown): Obj | undefined {
  return Array.isArray(v) ? obj(v[0]) : obj(v)
}
/** First scalar/flag value of a possibly command-indexed array field. */
function firstValue(v: unknown): unknown {
  if (!Array.isArray(v)) return v
  const first = v[0]
  const o = obj(first)
  return o && 'value' in o ? o['value'] : first
}

// ─── weapons ─────────────────────────────────────────────────────────────────

/**
 * Follow a weapon's `DisplayEffect` to the damage effect. Launch-missile / set /
 * persist effects are traversed (a few levels) to find the first effect with an
 * `Amount` — same best-effort the in-game UI applies via DisplayEffect.
 */
function resolveDamageEffect(mod: Sc2WikiSource, effectId: string, depth = 0): Obj | undefined {
  if (depth > 4) return undefined
  const e = mod.get('Effect', effectId)
  if (!e) return undefined
  const c = coerceEntity(e, mod) as Obj
  if (scalarNum(c['Amount']) !== undefined) return c
  for (const key of ['ImpactEffect', 'EffectArray', 'PeriodicEffectArray']) {
    const next = c[key]
    const ids = Array.isArray(next)
      ? next.map(x => (typeof x === 'string' ? x : str(obj(x)?.['value'])))
      : [typeof next === 'string' ? next : str(obj(next)?.['value'])]
    for (const id of ids) {
      if (!id) continue
      const found = resolveDamageEffect(mod, id, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

function buildWeapons(mod: Sc2WikiSource, resolver: CatalogResolver, refs: CardLink[]): CardWeapon[] {
  return refs.map(l => {
    const w: CardWeapon = { ...l }
    const e = mod.get('Weapon', l.id)
    if (!e) return w
    const c = coerceEntity(e, mod) as Obj
    const icon = str(c['Icon'])
    if (icon) w.iconAsset = icon
    const tooltip = html(mod, resolver, `Weapon/Tooltip/${l.id}`)
    if (tooltip) w.descriptionHtml = tooltip
    const range = num(c['Range'])
    if (range !== undefined) w.range = range
    const period = num(c['Period'])
    if (period !== undefined) w.period = period
    const attacks = num(c['DisplayAttackCount'])
    if (attacks !== undefined && attacks > 1) w.attacks = attacks
    const targets = targetFilterText(c['TargetFilters'])
    if (targets) w.targets = targets

    const effectId = str(c['DisplayEffect']) ?? str(c['Effect'])
    const dmgEffect = effectId ? resolveDamageEffect(mod, effectId) : undefined
    const dmg = dmgEffect
      ? scalarNum(dmgEffect['Amount'])
      : (scalarNum(c['DisplayEffectAmount']) ?? scalarNum(c['Amount']))
    if (dmg !== undefined) w.damage = dmg
    const bonusRec = dmgEffect ? obj(dmgEffect['AttributeBonus']) : undefined
    if (bonusRec) {
      const bonuses = Object.entries(bonusRec)
        .map(([attribute, amount]) => ({ attribute, amount: num(amount) ?? 0 }))
        .filter(b => b.amount !== 0)
      if (bonuses.length) w.bonuses = bonuses
    }
    if (dmg !== undefined && w.period)
      w.dps = Math.round(((dmg * (w.attacks ?? 1)) / w.period) * 10) / 10
    return w
  })
}

// ─── audio (via the unit's actors) ───────────────────────────────────────────

function buildSounds(
  ctx: CardContext,
  resolver: CatalogResolver,
  ns: string,
  id: string,
): CardSound[] {
  const { mod, graph } = ctx
  if (!graph) return []
  const sounds: CardSound[] = []
  const seen = new Set<string>()
  // Actors referencing this entity → their referenced Sounds → asset files.
  for (const ref of graph.incoming(ns, id)) {
    if (ref.to.namespace !== 'Actor') continue
    for (const sref of graph.outgoing('Actor', ref.to.id)) {
      if (sref.to.namespace !== 'Sound' || seen.has(sref.to.id)) continue
      seen.add(sref.to.id)
      const snd = mod.get('Sound', sref.to.id)
      if (!snd) continue
      const c = coerceEntity(snd, mod) as Obj
      const assets = c['AssetArray']
      const files: string[] = []
      if (Array.isArray(assets))
        for (const a of assets as Obj[]) {
          const f = str(a['File'])
          if (f) files.push(f)
        }
      if (files.length)
        sounds.push({
          id: sref.to.id,
          label: plain(mod, resolver, `Sound/Name/${sref.to.id}`) || sref.to.id,
          files,
        })
    }
  }
  return sounds
}

// ─── stats fields ────────────────────────────────────────────────────────────

/** Fields covered by dedicated card sections, or pure editor/AI noise (mirrors the reference wiki). */
const SKIP_FIELDS = new Set([
  'Name',
  'Description',
  'Tooltip',
  'Hotkey',
  'CardLayouts',
  'WeaponArray',
  'AbilArray',
  'BehaviorArray',
  'Attributes',
  'Icon',
  'class',
  'CostResource',
  'Food',
  'CostCategory',
  'Model',
  // editor/AI/telemetry noise (from the reference wiki's field filter)
  'FogVisibility',
  'ResourceState',
  'ResourceType',
  'Response',
  'ReviveInfoBase',
  'ReviveType',
  'DamageDealtXP',
  'DamageTakenXP',
  'DeathRevealDuration',
  'DeathRevealFilters',
  'DeathRevealRadius',
  'DeathRevealType',
  'DefaultAcquireLevel',
  'LeaderAlias',
  'Fidget',
  'Mass',
  'Mob',
  'TauntDuration',
  'HotkeyCategory',
  'EditorCategories',
  'ScoreResult',
  'GlossaryCategory',
  'Race',
  'ArmorType',
  'PawnItemReduction',
  'AIEvalFactor',
  'EditorFlags',
  'InnerRadiusSafetyMultiplier',
  'TacticalAIFilters',
  'TacticalAI',
  'KillDisplay',
  'AIEvaluateAlias',
  'SelfReviveCmd',
  'SharedFlags',
  'GlossaryStrongArray',
  'GlossaryWeakArray',
  'TechAliasArray',
  'SoundArray',
  'EquipmentArray',
])

/** Unit flags nobody reads in a wiki (the reference wiki filters the same set). */
const NOISE_FLAGS = new Set([
  'Movable',
  'Unclickable',
  'Unhighlightable',
  'Untooltipable',
  'KillCredit',
  'ShowResources',
  'ClearRallyOnTargetLost',
  'PlayerRevivable',
  'CameraFollow',
  'PreventDestroy',
  'UseLineOfSight',
  'TownAlert',
  'NoPortraitTalk',
  'TownCamera',
  'ArmorDisabledWhileConstructing',
  'AIThreatGround',
  'AIThreatAir',
  'AISupport',
  'NoDraw',
  'Buried',
  'Cloaked',
])

/** The catalog namespace a schema field links to, when the field is a plain entity link. */
function fieldLinkNamespace(schema: Obj, name: string): string | undefined {
  const t = schema[name] as { link?: unknown; prototype?: unknown } | undefined
  if (typeof t !== 'function') return undefined
  const link = (t as { link?: unknown }).link
  return typeof link === 'string' &&
    (t as { prototype?: unknown }).prototype instanceof CLink &&
    !Array.isArray((t as { extensions?: unknown }).extensions)
    ? link
    : undefined
}

/** Merged structure-types schema for a class name (parent chain applied), or `{}`. */
function classSchema(className: string): Obj {
  const cls = (DATA_CLASS_SCHEMA as Record<string, unknown>)[className] as
    { getMergedSchema?: () => Obj; schema?: Obj } | undefined
  if (!cls) return {}
  return (typeof cls.getMergedSchema === 'function' ? cls.getMergedSchema() : cls.schema) ?? {}
}

/** Compact display string for a coerced field value (objects/arrays flattened, quotes stripped). */
function formatFieldValue(name: string, value: unknown): string | undefined {
  let v = value
  // Flag objects ({Ground:true, Small:true}) list only the SET flags: "Ground, Small".
  const o = obj(v)
  if (o && Object.keys(o).length > 0 && Object.values(o).every(x => typeof x === 'boolean')) {
    const noise = name === 'FlagArray' || name === 'Flags' ? NOISE_FLAGS : undefined
    v = Object.entries(o)
      .filter(([k, on]) => on === true && !noise?.has(k))
      .map(([k]) => k)
    if ((v as string[]).length === 0) return undefined
  }
  let s: string
  if (v === null || v === undefined) return undefined
  else if (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null))
    s = v.map(String).join(', ')
  else if (typeof v === 'object') {
    s = JSON.stringify(v).replace(/"/g, '')
    if (s.startsWith('[') || s.startsWith('{')) s = s.slice(1, -1)
  } else s = String(v)
  if (!s) return undefined
  return s.length > 160 ? `${s.slice(0, 159)}…` : s
}

function buildFields(u: Obj, className: string): CardField[] {
  const schema = classSchema(className)
  const fields: CardField[] = []
  for (const name of Object.keys(u).sort((a, b) => a.localeCompare(b))) {
    if (SKIP_FIELDS.has(name)) continue
    if (/^(Life|Shields?|Energy)[A-Z]/.test(name) || name === 'Shields') continue // covered by vitals
    const value = formatFieldValue(name, u[name])
    if (value === undefined) continue
    const field: CardField = { name, value }
    const raw = u[name]
    // Only plain scalar fields (`<Name value="…"/>` in XML) are surgically editable from
    // the card; arrays/structs need the XML editor.
    if (raw === null || typeof raw !== 'object') field.editable = true
    const linkNs = fieldLinkNamespace(schema, name)
    if (linkNs) field.linkNs = linkNs
    fields.push(field)
  }
  return fields
}

// ─── icons ───────────────────────────────────────────────────────────────────

/** Raw resolved scalar: plain string or a `{ value }` wrapper. */
function rawStr(v: unknown): string | undefined {
  return str(v) ?? str(obj(v)?.['value'])
}

/**
 * A field value that IS a GameStrings key (`Button/Tooltip/Probe` — entities carry their
 * text keys in `Name`/`Tooltip`/`Description` fields). Requires a `/` so plain scalars
 * are never mistaken for keys.
 */
function keyOf(v: unknown): string | undefined {
  const s = rawStr(v)
  return s && s.includes('/') ? s : undefined
}

/**
 * Candidate Button faces that represent an entity in the UI: a same-id Button, then the
 * Buttons of the train/build commands that produce it (`SAbilCmdButton.DefaultButtonFace`
 * via the relation graph). Real GameStrings keep BOTH the unit's icon and its descriptive
 * text on these buttons (`Button/Tooltip/<face>` — there are no `Unit/Tooltip|Description`
 * keys in shipped data), so icon and description derivation must agree.
 */
export function entityButtonFaces(
  mod: Sc2WikiSource,
  ns: string,
  id: string,
  graph?: CardGraph,
): string[] {
  const faces: string[] = []
  if (mod.getResolved('Button', id)) faces.push(id)
  if (ns !== 'Unit' || !graph) return faces
  let checked = 0
  for (const ref of graph.incoming(ns, id)) {
    if (ref.to.namespace !== 'Abil' || checked++ > 8) continue
    const abil = mod.get('Abil', ref.to.id)
    if (!abil) continue
    const a = coerceEntity(abil, mod) as Obj
    for (const entry of infoEntries(a['InfoArray'])) {
      const unit = entry['Unit']
      const units = Array.isArray(unit) ? unit.map(String) : [String(unit ?? '')]
      if (!units.includes(id)) continue
      const face = str(obj(entry['Button'])?.['DefaultButtonFace'])
      if (face && !faces.includes(face)) faces.push(face)
    }
  }
  return faces
}

/**
 * Best-effort icon asset for an entity. Most icon-bearing classes (Button, Upgrade,
 * Weapon, Race, …) carry `Icon` directly; units don't — their wiki icon comes from a
 * representing button (see {@link entityButtonFaces}).
 */
export function entityIconAsset(
  mod: Sc2WikiSource,
  ns: string,
  id: string,
  graph?: CardGraph,
): string | undefined {
  const own = rawStr((mod.getResolved(ns, id) as Obj | undefined)?.['Icon'])
  if (own) return own
  for (const face of entityButtonFaces(mod, ns, id, graph)) {
    const icon = rawStr((mod.getResolved('Button', face) as Obj | undefined)?.['Icon'])
    if (icon) return icon
  }
  return undefined
}

/** All entries of a coerced command-indexed collection (array or word-keyed map). */
function infoEntries(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.filter((x): x is Obj => obj(x) !== undefined)
  const o = obj(v)
  if (!o) return []
  if ('index' in o || 'value' in o) return [o]
  return Object.values(o).filter((x): x is Obj => obj(x) !== undefined)
}

// ─── vitals ──────────────────────────────────────────────────────────────────

function buildVitals(u: Obj): CardVital[] {
  const vitals: CardVital[] = []
  for (const key of ['Life', 'Shields', 'Energy'] as const) {
    const max = num(u[`${key}Max`])
    if (!max) continue
    const v: CardVital = { name: key, max }
    const start = num(u[`${key}Start`])
    if (start !== undefined && start !== max) v.start = start
    const armor = num(u[`${key}Armor`])
    if (armor !== undefined) v.armor = armor
    const armorIcon = str(u[`${key}ArmorIcon`])
    if (armorIcon) v.armorIcon = armorIcon
    const regen = num(u[`${key}RegenRate`])
    if (regen) v.regen = Math.round(regen * 100) / 100
    vitals.push(v)
  }
  return vitals
}

// ─── main ────────────────────────────────────────────────────────────────────

/** Max navigable links kept per relation group (totals stay exact). */
const REL_GROUP_CAP = 60

export function buildEntityCard(ctx: CardContext, ns: string, id: string): EntityCard {
  const { mod, graph } = ctx
  const resolver = makeResolver(mod, ctx.locale)
  const entity = mod.get(ns, id)
  const u = (entity ? coerceEntity(entity, mod) : {}) as Obj
  const className = entity?.class ?? `C${ns}`

  const refLinks = (refs: RefLike[]): CardLink[] => {
    const out: CardLink[] = []
    const seen = new Set<string>()
    for (const r of refs) {
      const k = `${r.to.namespace}/${r.to.id}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(linkLabel(mod, resolver, r.to.namespace, r.to.id))
    }
    return out
  }
  /** Dedupe + group one direction's refs by namespace, largest groups first. */
  const relGroups = (refs: RefLike[]): CardRelGroup[] => {
    const byNs = new Map<string, Map<string, true>>()
    for (const r of refs) {
      const ids = byNs.get(r.to.namespace) ?? new Map()
      ids.set(r.to.id, true)
      byNs.set(r.to.namespace, ids)
    }
    return [...byNs]
      .map(([groupNs, ids]) => ({
        ns: groupNs,
        total: ids.size,
        links: [...ids.keys()]
          .slice(0, REL_GROUP_CAP)
          .map(refId => linkLabel(mod, resolver, groupNs, refId)),
      }))
      .sort((a, b) => b.total - a.total || a.ns.localeCompare(b.ns))
  }
  const out = graph ? graph.outgoing(ns, id) : []
  const byNs = (n: string): CardLink[] => refLinks(out.filter(r => r.to.namespace === n))

  // Cost.
  const cr = (u['CostResource'] as Obj) ?? {}
  const cost = {
    ...(num(cr['Minerals']) ? { minerals: num(cr['Minerals']) } : {}),
    ...(num(cr['Vespene']) ? { vespene: num(cr['Vespene']) } : {}),
    ...(num(u['Food']) ? { supply: num(u['Food']) } : {}),
  }

  const attributes = Array.isArray(u['Attributes'])
    ? (u['Attributes'] as string[]).map(String)
    : obj(u['Attributes'])
      ? Object.entries(u['Attributes'] as Obj)
          .filter(([, on]) => on === true)
          .map(([k]) => k)
      : []
  const model = byNs('Model')[0]
  const producers: CardProducer[] =
    ns === 'Unit' && graph?.unitProducers
      ? graph.unitProducers(id).map(item => ({
          kind: item.kind,
          category: item.category,
          creator: linkLabel(mod, resolver, item.creator.namespace, item.creator.id),
          path: item.path,
          routes: item.routes.map(route => ({
            producer: linkLabel(mod, resolver, route.producer.namespace, route.producer.id),
            via: route.chain
              .slice(1, -1)
              .map(item => linkLabel(mod, resolver, item.from.namespace, item.from.id)),
          })),
          triggers: item.triggers.map(trigger => ({
            ...trigger,
            initiates: linkLabel(mod, resolver, trigger.initiates.namespace, trigger.initiates.id),
          })),
        }))
      : []

  const card: EntityCard = {
    ns,
    id,
    className,
    name: plain(mod, resolver, keyOf(u['Name']) ?? `${ns}/Name/${id}`) || id,
    vitals: buildVitals(u),
    attributes,
    fields: buildFields(u, className),
    cost: Object.keys(cost).length ? cost : undefined,
    commandCards: buildCommandCards(mod, resolver, u),
    weapons: buildWeapons(mod, resolver, byNs('Weapon')),
    abilities: byNs('Abil'),
    behaviors: byNs('Behavior'),
    producers,
    sounds: buildSounds(ctx, resolver, ns, id),
    relationsOut: relGroups(out),
    relationsIn: graph ? relGroups(graph.incoming(ns, id)) : [],
    locales: [...mod.locales.keys()],
  } as EntityCard

  if (entity?.source)
    card.source = {
      mod: entity.source.mod,
      file: entity.source.file,
      ...(entity.source.line !== undefined ? { line: entity.source.line } : {}),
    }
  const allSources = entity?.sources ?? (entity?.source ? [entity.source] : [])
  if (allSources.length) {
    card.sources = allSources.map(s => ({
      mod: s.mod,
      file: s.file,
      ...(s.line !== undefined ? { line: s.line } : {}),
    }))
  }
  // Description: the entity's own Description/Tooltip FIELDS carry the string key
  // (CUnit.Description = `Button/Tooltip/##id##` in shipped data — token-substituted by
  // coerceEntity); conventional keys and the representing button's tooltip are fallbacks.
  let desc =
    styled(resolver, keyOf(u['Description']) ?? `${ns}/Description/${id}`) ??
    styled(resolver, keyOf(u['Tooltip']) ?? `${ns}/Tooltip/${id}`)
  if (!desc?.html) {
    for (const face of entityButtonFaces(mod, ns, id, graph)) {
      const faceBtn = mod.get('Button', face)
      const fc = faceBtn ? (coerceEntity(faceBtn, mod) as Obj) : {}
      desc = styled(resolver, keyOf(fc['Tooltip']) ?? `Button/Tooltip/${face}`)
      if (desc?.html) break
    }
  }
  if (desc?.html) {
    card.descriptionHtml = desc.html
    card.descriptionRuns = desc.runs
  }
  // Own Icon field → button-derived icon (units) → first own command-card button.
  const icon =
    str(u['Icon']) ??
    entityIconAsset(mod, ns, id, graph) ??
    card.commandCards[0]?.buttons.find(b => b.iconAsset)?.iconAsset
  if (icon) card.iconAsset = icon
  if (model) {
    const m = mod.get('Model', model.id)
    const mf = m ? str((coerceEntity(m, mod) as Obj)['Model']) : undefined
    if (mf) card.modelAsset = mf
  }
  if (!card.modelAsset) {
    const mf = deriveActorModel(mod, graph, ns, id)?.file
    if (mf) card.modelAsset = mf
  }
  return card
}
