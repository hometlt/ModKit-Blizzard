/**
 * Warcraft III object data from the game's text tables, as entity patches for the one resolver
 * (`resolveDataCatalog` of `@modkit/sdk`): units, items, abilities, buffs, upgrades, destructables and
 * doodads.
 *
 * - A kind's sheets (`Units/UnitData.slk`, `UnitBalance`, …) each key a row by the id in their
 *   first column; a row is one patch whose fields are `<sheet>.<column>`.
 * - A kind's profiles (`Units/<race>UnitFunc.txt`, `<race>AbilityStrings.txt`, …) are INI sections
 *   keyed by the same id; a section is one patch of that kind whose fields are `Profile.<key>`.
 *   Reforged (1.32+) moved art out of the sheets into skin profiles (`Units/UnitSkin.txt`,
 *   `DestructableSkin.txt`, `Doodads/DoodadSkins.txt`, `ItemSkin.txt` and their strings): `file`,
 *   `numVar`, `modelScale`, a value for one art set as `<key>:hd` / `<key>:sd`. Older versions have
 *   no such files and read as before.
 *   Profile keys are read without case, as the game reads them, and spelled as the metadata sheets
 *   (`UnitMetaData.slk`, …) spell them. Buff IDs come from AbilityBuffData.slk and their metadata
 *   from AbilityBuffMetaData.slk; shared ability-profile sections are routed by these declared IDs
 *   and typed w3h/w3a declarations (including custom IDs). Native Bufftip/Buffubertip declarations
 *   identify buffs when editor-only sheets are absent; generic Art/Name do not.
 *   not by rawcode spelling. An ID declared as both ability and buff has an ambiguous profile.
 * - A value is the text as the file writes it; a profile value loses one pair of quotes around it.
 * - A field the metadata types as a list or code of units, items, abilities or upgrades
 *   (`UnitAbilities.abilList`, `Profile.Trains`, `Profile.Researches`, …) is a list of ids that links
 *   to those entities; `techList` (`Requires`) mixes units and upgrades and stays text, as do the
 *   per-level ability columns, whose kind (unit, ability, upgrade, number) the metadata sets per
 *   ability (`useSpecific`): a schema field links to one namespace for every entity of its type.
 *   Link rules are scoped by object kind; useSpecific/notSpecific and conflicting row types stay text rather
 *   than creating universal links into the wrong namespace. Read-only numeric types describe only
 *   the supplied snapshot: agreeing scalar metadata and every supplied value must qualify. Raw
 *   strings are never converted; no default, unit, editor bound or write authority is inferred.
 *   Optional UI/UnitEditorData.txt supplies qualified scalar enum IDs (unitRace/moveType,
 *   defenseType/weaponType/attackType/attributeType/regenType), never reference-engine aliases/defaults;
 *   indexed/repeated/conditional/conflicting fields, malformed addressing integers or values outside the native domain stay
 *   untyped. Display-string keys and additional columns are not enum members or localized labels;
 *   version/mode-dependent filtering of declared choices is not implemented.
 *   Native empty/_/- strings use the common enum unknown marker, never fake native members.
 * - The game reads each file once, from the highest layer that has it: a map importing its own
 *   `Units/UnitData.slk` replaces the game's sheet whole, so only the latest root's copy is read.
 * - A map's object-editor changes (`war3map.w3u` …, read as binary documents) come after the tables:
 *   a change names its field by the metadata id (`uhpm` → `UnitBalance.HP`; an ability's `Hbz2` at
 *   level 2 → `AbilityData.DataB2`; a profile field with an index or per-level values replaces one
 *   element of its comma list). A custom object is a patch whose parent is its base. A change whose
 *   id no supplied metadata sheet names is reported, not guessed. Map skin and
 *   campaign change files follow their ordinary map counterpart within a root; workspace roots
 *   retain load order. String changes resolve through that root's map/campaign WTS scope.
 */
import type {
  DataCatalogDiagnostic,
  DataCatalogDocument,
  DataEntityPatch,
  DataSchemaField,
  DataTypeSchema,
} from '@modkit/sdk/data'
import { decodeInput, parseIni, parseSylk } from '@modkit/codec-kit/text'
import { parseWts } from '../wts/format.js'
import { qualifyWar3EnumFields, readWar3EnumTypes } from './enums.js'
import type Modification from '../lib/mdx-m3-viewer/parsers/w3x/w3u/modification.js'
import { OBJECT_MOD_KINDS, extensionOf, modValue, objectId, readObjectMods } from '../war3-object-mods/format.js'

interface Kind {
  /** Namespace and type of the kind's entities. */
  readonly id: string
  /** Sheets by path, each with the name its fields carry. */
  readonly sheets: readonly { readonly path: string; readonly label: string }[]
  readonly profiles: readonly string[]
  readonly metadata?: string
}

const profiles = (kind: string, sources: readonly string[]) =>
  sources.flatMap(source => [`Units/${source}${kind}Func.txt`, `Units/${source}${kind}Strings.txt`])
const RACES = ['Human', 'Orc', 'Undead', 'NightElf', 'Neutral', 'Campaign'] as const
const sheet = (path: string) => ({ path, label: path.slice(path.lastIndexOf('/') + 1, -'.slk'.length) })

export const WAR3_DATA_KINDS: readonly Kind[] = [
  {
    id: 'unit',
    sheets: [
      sheet('Units/UnitData.slk'),
      sheet('Units/UnitBalance.slk'),
      { path: 'Units/UnitUI.slk', label: 'UnitUI' },
      sheet('Units/UnitWeapons.slk'),
      sheet('Units/UnitAbilities.slk'),
    ],
    profiles: [...profiles('Unit', RACES), 'Units/UnitSkin.txt', 'Units/UnitSkinStrings.txt', 'Units/UnitWeaponsFunc.txt', 'Units/UnitWeaponsSkin.txt'],
    metadata: 'Units/UnitMetaData.slk',
  },
  {
    id: 'item',
    sheets: [sheet('Units/ItemData.slk')],
    profiles: ['Units/ItemFunc.txt', 'Units/ItemStrings.txt', 'Units/ItemSkin.txt', 'Units/ItemSkinStrings.txt'],
  },
  {
    id: 'ability',
    sheets: [sheet('Units/AbilityData.slk')],
    profiles: [...profiles('Ability', [...RACES, 'Common', 'Item']), 'Units/AbilitySkin.txt'],
    metadata: 'Units/AbilityMetaData.slk',
  },
  {
    id: 'buff',
    sheets: [sheet('Units/AbilityBuffData.slk')],
    // Buffs share the ability profiles, routed below using their sheet declarations.
    profiles: [],
    metadata: 'Units/AbilityBuffMetaData.slk',
  },
  { id: 'upgrade', sheets: [sheet('Units/UpgradeData.slk')], profiles: profiles('Upgrade', RACES), metadata: 'Units/UpgradeMetaData.slk' },
  {
    id: 'destructable',
    sheets: [sheet('Units/DestructableData.slk')],
    profiles: ['Units/DestructableSkin.txt', 'Units/DestructableSkinStrings.txt'],
    metadata: 'Units/DestructableMetaData.slk',
  },
  {
    id: 'doodad',
    sheets: [sheet('Doodads/Doodads.slk')],
    profiles: ['Doodads/DoodadSkins.txt', 'Doodads/DoodadSkinStrings.txt'],
    metadata: 'Doodads/DoodadMetaData.slk',
  },
]

/** Root-relative editor enums/metadata, then the sheets and profiles the object data reads. */
export const WAR3_DATA_DOCUMENTS: readonly string[] = [
  'UI/UnitEditorData.txt',
  ...WAR3_DATA_KINDS.flatMap(kind => (kind.metadata === undefined ? [] : [kind.metadata])),
  ...WAR3_DATA_KINDS.flatMap(kind => kind.sheets.map(item => item.path)),
  ...WAR3_DATA_KINDS.flatMap(kind => kind.profiles),
]

/** Native changes in their same-root precedence, as Warsmash Warcraft3MapObjectData loads them. */
export const WAR3_OBJECT_MOD_DOCUMENTS: readonly string[] = ['war3map', 'war3mapSkin', 'war3campaign']
  .flatMap(stem => Object.keys(OBJECT_MOD_KINDS).map(extension => `${stem}.${extension}`))

/** Trigger strings are scoped by map/campaign, not a single global TRIGSTR registry. */
export const WAR3_DATA_STRING_DOCUMENTS = ['war3map.wts', 'war3campaign.wts'] as const

/** Native unit/doodad/UI/change-document key, whichever workspace root it is under. */
const key = (path: string) => {
  const folded = path.replaceAll('\\', '/').toLowerCase()
  return /(?:^|\/)((?:units|doodads|ui)\/[^/]+|war3(?:mapskin|map|campaign)\.[^/]+)$/u.exec(folded)?.[1] ?? folded
}

const byPath = new Map<string, { readonly kind: Kind; readonly label?: string }>([
  ...WAR3_DATA_KINDS.flatMap(kind => kind.sheets.map(item => [key(item.path), { kind, label: item.label }] as const)),
  ...WAR3_DATA_KINDS.flatMap(kind => kind.profiles.map(path => [key(path), { kind }] as const)),
])
const metadataKinds = new Map(WAR3_DATA_KINDS.flatMap(kind => (kind.metadata === undefined ? [] : [[key(kind.metadata), kind.id] as const])))

/** A sheet's rows as `{ id, fields }` by its header row; the first column is the id. */
function sheetRows(text: string, label: string, diagnostics: DataCatalogDiagnostic[], source: DataEntityPatch['source']) {
  const parsed = parseSylk(decodeInput({ text }))
  if (parsed.state === 'failed') {
    diagnostics.push({ severity: 'error', code: 'blizzard.warcraft3/data-sheet-unreadable', message: `${source.path}: ${parsed.diagnostics[0]?.message ?? 'not SYLK'}`, source })
    return []
  }
  if (parsed.state !== 'ok' || parsed.diagnostics.length > 0)
    diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-sheet-unqualified', message: `${source.path}: the supplied sheet has parsing diagnostics; numeric domain is not qualified`, source })
  const [header, ...rows] = parsed.document.rows
  if (header === undefined || header.index !== 1) return []
  const names = new Map(header.cells.map(cell => [cell.column, cell.value]))
  const out: { id: string; fields: Record<string, string> }[] = []
  for (const row of rows) {
    const idCell = row.cells.find(cell => cell.column === 1)
    if (idCell === undefined || idCell.value === '') continue
    const fields: Record<string, string> = {}
    for (const cell of row.cells) {
      const name = names.get(cell.column)
      if (cell.column === 1 || name === undefined || name === '') continue
      fields[`${label}.${name}`] = cell.value
    }
    out.push({ id: idCell.value, fields })
  }
  return out
}

/** The kind a metadata field type links to. */
const LINK_TYPES: Readonly<Record<string, string>> = {
  abilityList: 'ability',
  heroAbilityList: 'ability',
  abilCode: 'ability',
  buffList: 'buff',
  buffCode: 'buff',
  unitList: 'unit',
  itemList: 'item',
  upgradeList: 'upgrade',
}

/** What a metadata row says of a field id: where its value lives. */
interface MetaField {
  readonly sheet: string
  readonly field: string
  /** The element of a profile's comma list, or -1 for the whole value. */
  readonly index: number
  /** More than 0: one value a level (a column `<field>1`…, or a profile list element). */
  readonly repeat: number
  /** An ability data field's letter (1 → `DataA`), or 0. */
  readonly data: number
}

/** Metadata names a few sheets other than their files. */
const SHEET_ALIASES: Readonly<Record<string, string>> = { DoodadData: 'Doodads' }

/**
 * What the metadata sheets say: how each profile key is spelled (by the key in lower case), which
 * fields link to which kind (scoped to the owning object kind), and where each native field id lives.
 * Scalar type names require agreeing, unindexed/unrepeated metadata rows with valid safe integers.
 */
function readMetadata(text: string, kind: string, spellings: Map<string, string>, links: Map<string, string | null>, fields: Map<string, MetaField>, typeNames: Map<string, string | null>): boolean {
  const parsed = parseSylk(decodeInput({ text }))
  if (parsed.state === 'failed') return false
  const [header, ...rows] = parsed.document.rows
  const column = (name: string) => header?.cells.find(cell => cell.value === name)?.column
  const field = column('field')
  const slk = column('slk')
  const type = column('type')
  const useSpecific = column('useSpecific')
  const notSpecific = column('notSpecific')
  const idColumn = column('ID')
  const numbers = { index: column('index'), repeat: column('repeat'), data: column('data') }
  for (const row of rows) {
    const value = (at: number | undefined) => row.cells.find(cell => cell.column === at)?.value
    const name = value(field)
    const sheetName = value(slk)
    if (name === undefined || sheetName === undefined) continue
    if (sheetName === 'Profile' && !spellings.has(name.toLowerCase())) spellings.set(name.toLowerCase(), name)
    const number = (at: number | undefined, fallback: number) => {
      const parsed = Number(value(at))
      return value(at) === undefined || !Number.isInteger(parsed) ? fallback : parsed
    }
    const fieldId = value(idColumn)
    if (fieldId !== undefined)
      fields.set(fieldId, {
        sheet: SHEET_ALIASES[sheetName] ?? sheetName,
        field: name,
        index: number(numbers.index, -1),
        repeat: number(numbers.repeat, 0),
        data: number(numbers.data, 0),
      })
    const target = LINK_TYPES[value(type) ?? '']
    const linkKey = `${kind}/${SHEET_ALIASES[sheetName] ?? sheetName}.${sheetName === 'Profile' ? (spellings.get(name.toLowerCase()) ?? name) : name}`
    // A field-wide link/type cannot express inclusion or exclusion of particular native abilities.
    // null blocks promotion regardless of row order; fields of other object kinds stay independent.
    const conditional = Boolean(value(useSpecific)?.trim() || value(notSpecific)?.trim())
    const candidate = conditional ? null : target ?? null
    const previous = links.get(linkKey)
    links.set(linkKey, links.has(linkKey) && previous !== candidate ? null : candidate)
    // Native change addressing keeps its legacy defaults; those defaults cannot prove a scalar
    // type when an authored numeric token is malformed, fractional or outside exact integer range.
    const scalarNumbersValid = Object.values(numbers).every(at => {
      const raw = value(at)
      return raw === undefined || (/^-?\d+$/u.test(raw) && Number.isSafeInteger(Number(raw)))
    })
    const scalarType = scalarNumbersValid && !conditional && number(numbers.index, -1) === -1 &&
      number(numbers.repeat, 0) === 0 && number(numbers.data, 0) === 0 ? value(type) ?? null : null
    const previousType = typeNames.get(linkKey)
    typeNames.set(linkKey, typeNames.has(linkKey) && previousType !== scalarType ? null : scalarType)
  }
  return parsed.state === 'ok' && parsed.diagnostics.length === 0 && field !== undefined && slk !== undefined && type !== undefined
}

/** A list field's ids; `_`, `-` and empty mean none. */
const ids = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '' && item !== '_' && item !== '-')

const unquoted = (value: string) => (value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)

/** Where an object-editor change lands: a field, and for a list the element it replaces. */
function changeTarget(
  meta: MetaField | undefined,
  change: Modification,
  levels: boolean,
  spellings: ReadonlyMap<string, string>,
): { readonly field: string; readonly element?: number } | undefined {
  if (meta === undefined) return undefined
  const level = levels ? change.levelOrVariation : 0
  if (meta.sheet === 'Profile') {
    const field = `Profile.${spellings.get(meta.field.toLowerCase()) ?? meta.field}`
    const element = meta.repeat > 0 && level > 0 ? level - 1 : meta.index >= 0 ? meta.index : undefined
    return element === undefined ? { field } : { field, element }
  }
  const letter = meta.data > 0 ? ('ABCDEFGHI'[meta.data - 1] ?? '') : ''
  return { field: `${meta.sheet}.${meta.field}${letter}${meta.repeat > 0 && level > 0 ? String(level) : ''}` }
}

/** A comma list with one element replaced; commas inside quotes belong to their element. */
function withElement(list: string, element: number, value: string): string {
  const items: string[] = []
  if (list !== '') {
    let item = ''
    let quoted = false
    for (const char of list) {
      if (char === '"') quoted = !quoted
      if (char === ',' && !quoted) {
        items.push(item)
        item = ''
      } else item += char
    }
    items.push(item)
  }
  while (items.length <= element) items.push('')
  items[element] = value.includes(',') ? `"${value}"` : value
  return items.join(',')
}

export interface War3DataPatches {
  readonly patches: readonly DataEntityPatch[]
  readonly schemas: readonly DataTypeSchema[]
  readonly diagnostics: readonly DataCatalogDiagnostic[]
}

/**
 * The object patches of the documents the host read, in plan order (base roots first). A path read
 * from several roots counts only in the last one.
 * Numeric annotation requires caller-certified input bounds, not native context completeness;
 * uncertified direct calls retain the previous untyped behavior.
 */
export function war3DataPatches(documents: readonly DataCatalogDocument[], suppliedDomainWithinBudget = false): War3DataPatches {
  const roots = [...new Set(documents.map(document => document.rootId))]
  const winner = new Map<string, number>()
  documents.forEach((document, index) => winner.set(key(document.path), index))
  const diagnostics: DataCatalogDiagnostic[] = []
  const strings = new Map<string, ReadonlyMap<number, string>>()
  for (const [documentIndex, document] of documents.entries()) {
    const path = key(document.path)
    if (!(WAR3_DATA_STRING_DOCUMENTS as readonly string[]).includes(path)) continue
    // An unreadable override shadows the earlier file too; it must not resurrect stale strings.
    strings.set(`${document.rootId}/${path}`, new Map())
    const parsed = parseWts(document.text)
    const source = { rootId: document.rootId, path: document.path, documentIndex }
    if (parsed.errors.length > 0) {
      diagnostics.push({ severity: 'error', code: 'blizzard.warcraft3/data-strings-unreadable', message: `${document.path}: ${parsed.errors[0]!.message}`, source })
      continue
    }
    strings.set(`${document.rootId}/${path}`, new Map(parsed.entries.map(entry => [entry.id, entry.text])))
  }
  const read = documents.flatMap((document, documentIndex) => {
    const source = {
      rootId: document.rootId,
      path: document.path,
      documentIndex,
      ...(document.revision === undefined ? {} : { revision: document.revision }),
    }
    if (winner.get(key(document.path)) !== documentIndex) {
      diagnostics.push({ severity: 'information', code: 'blizzard.warcraft3/data-file-replaced', message: `${document.rootId}:${document.path} is replaced by a later layer's copy; the game reads only that one`, source })
      return []
    }
    return [{ document, source }]
  })
  const spellings = new Map<string, string>()
  const links = new Map<string, string | null>()
  const meta = new Map<string, MetaField>()
  const typeNames = new Map<string, string | null>()
  let metadataQualified = true
  for (const { document } of read) {
    const kind = metadataKinds.get(key(document.path))
    if (kind !== undefined) metadataQualified = readMetadata(document.text, kind, spellings, links, meta, typeNames) && metadataQualified
  }
  const patches: DataEntityPatch[] = []
  // Parse each sheet once before profile routing: caller document order must not decide a kind.
  const sheetRecords = new Map(read.flatMap(({ document, source }) => {
    const owner = byPath.get(key(document.path))
    return owner?.label === undefined ? [] : [[source.documentIndex, {
      kind: owner.kind.id, rows: sheetRows(document.text, owner.label, diagnostics, source),
    }] as const]
  }))
  const buffIds = new Set([...sheetRecords.values()].filter(record => record.kind === 'buff').flatMap(record => record.rows.map(row => row.id)))
  const abilityIds = new Set([...sheetRecords.values()].filter(record => record.kind === 'ability').flatMap(record => record.rows.map(row => row.id)))
  // Classic deployments may lack editor-only buff sheets. Native buff tooltip declarations in
  // the shared profiles still identify their owner; generic Art/Name and rawcode prefixes do not.
  const profileRecords = new Map(read.flatMap(({ document, source }) => {
    const owner = byPath.get(key(document.path))
    if (owner === undefined || owner.label !== undefined) return []
    const parsed = parseIni(decodeInput({ text: document.text }), 'ini-war3')
    if (parsed.state === 'failed') {
      diagnostics.push({ severity: 'error', code: 'blizzard.warcraft3/data-profile-unreadable', message: `${document.path}: ${parsed.diagnostics[0]?.message ?? 'not a profile'}`, source })
      return []
    }
    if (owner.kind.id === 'ability') for (const section of parsed.document.sections)
      if (section.entries.some(entry => ['bufftip', 'buffubertip'].includes(entry.key.toLowerCase()))) buffIds.add(section.name)
    return [[source.documentIndex, parsed.document] as const]
  }))
  // Typed binary declarations also identify custom objects whose shared profiles precede changes.
  const objectMods = new Map<number, ReturnType<typeof readObjectMods>>()
  for (const { document, source } of read) {
    if (!WAR3_OBJECT_MOD_DOCUMENTS.some(path => key(path) === key(document.path)) || document.bytes === undefined) continue
    const extension = extensionOf(document.path)
    try {
      const mods = readObjectMods(document.bytes, extension)
      // v3 is one modification list, not multiple sets. Keep inspection lossless while refusing
      // semantic projection of opaque headers beyond the empty / single-zero compatibility cases.
      if (mods.version === 3 && [...mods.original.objects, ...mods.custom.objects]
        .some(object => object.unknownInts.length > 1 || object.unknownInts.some(value => value !== 0)))
        throw new TypeError('object-editor v3 unknown header semantics are unsupported for resolved data')
      objectMods.set(source.documentIndex, mods)
      const declared = extension === 'w3h' ? buffIds : extension === 'w3a' ? abilityIds : undefined
      if (declared !== undefined) {
        for (const object of mods.original.objects) declared.add(objectId(object.oldId))
        for (const object of mods.custom.objects) {
          declared.add(objectId(object.oldId))
          declared.add(objectId(object.newId))
        }
        declared.delete('')
      }
    } catch (error) {
      diagnostics.push({ severity: 'error', code: 'blizzard.warcraft3/object-mods-unreadable', message: `${document.path}: ${error instanceof Error ? error.message : String(error)}`, source })
    }
  }
  const fieldIds = new Map(WAR3_DATA_KINDS.map(kind => [kind.id, new Set<string>()]))
  /** Each entity's text values so far, for a change that replaces one element of a list. */
  const current = new Map<string, Record<string, string>>()
  const add = (kind: string, entityId: string, fields: Record<string, string>, source: DataEntityPatch['source'], parentEntityId?: string) => {
    const values: Record<string, string | string[]> = {}
    const known = current.get(`${kind}/${entityId}`) ?? {}
    for (const [field, value] of Object.entries(fields)) {
      fieldIds.get(kind)!.add(field)
      values[field] = typeof links.get(`${kind}/${field}`) === 'string' ? ids(value) : value
      known[field] = value
    }
    current.set(`${kind}/${entityId}`, known)
    patches.push({ namespace: kind, typeId: kind, entityId, ...(parentEntityId === undefined ? {} : { parentEntityId }), fields: values, source })
  }
  for (const { document, source } of read) {
    const owner = byPath.get(key(document.path))
    if (owner === undefined) continue
    if (owner.label !== undefined) {
      for (const row of sheetRecords.get(source.documentIndex)?.rows ?? []) add(owner.kind.id, row.id, row.fields, source)
      continue
    }
    const profile = profileRecords.get(source.documentIndex)
    if (profile === undefined) continue
    for (const section of profile.sections) {
      if (section.name === '' || section.entries.length === 0) continue
      if (owner.kind.id === 'ability' && buffIds.has(section.name) && abilityIds.has(section.name)) {
        diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-profile-kind-ambiguous', message: `${document.path}: ${section.name} is declared as both ability and buff; shared profile is not assigned`, source })
        continue
      }
      const fields: Record<string, string> = {}
      // A key written twice in a section: the later line counts.
      for (const entry of section.entries) fields[`Profile.${spellings.get(entry.key.toLowerCase()) ?? entry.key}`] = unquoted(entry.value)
      add(owner.kind.id === 'ability' && buffIds.has(section.name) ? 'buff' : owner.kind.id, section.name, fields, source)
    }
  }
  // Root order is authoritative; within a root the native map, skin and campaign order is fixed,
  // even if a caller supplies its already-planned documents in a different order.
  const changes = read.filter(({ document }) => WAR3_OBJECT_MOD_DOCUMENTS.some(path => key(path) === key(document.path)))
    .sort((a, b) => roots.indexOf(a.document.rootId) - roots.indexOf(b.document.rootId) ||
      WAR3_OBJECT_MOD_DOCUMENTS.findIndex(path => key(path) === key(a.document.path)) -
      WAR3_OBJECT_MOD_DOCUMENTS.findIndex(path => key(path) === key(b.document.path)))
  for (const { document, source } of changes) {
    const extension = extensionOf(document.path)
    const kind = OBJECT_MOD_KINDS[extension]
    const mods = objectMods.get(source.documentIndex)
    if (kind === undefined || mods === undefined) continue
    const unmapped = new Set<string>()
    const missingStrings = new Set<string>()
    const stringPath = key(document.path).startsWith('war3campaign.') ? 'war3campaign.wts' : 'war3map.wts'
    // A later map's WTS must never relabel an earlier campaign's changes.
    const scopedStrings = roots.slice(0, roots.indexOf(document.rootId) + 1).reverse()
      .map(root => strings.get(`${root}/${stringPath}`)).find(table => table !== undefined)
    /** Resolve only an authored string reference, retaining missing keys for diagnostics/editing. */
    const valueOf = (change: Modification): string => {
      const raw = modValue(change)
      const match = change.variableType === 3 ? /^TRIGSTR_(\d+)$/u.exec(raw) : null
      if (match === null) return raw
      const translated = scopedStrings?.get(Number(match[1]))
      if (translated === undefined) missingStrings.add(raw)
      return translated ?? raw
    }
    for (const [table, custom] of [[mods.original, false], [mods.custom, true]] as const) {
      for (const object of table.objects) {
        const base = objectId(object.oldId)
        const entityId = custom ? objectId(object.newId) : base
        if (entityId === '') continue
        const known = current.get(`${kind.namespace}/${entityId}`) ?? (custom ? current.get(`${kind.namespace}/${base}`) : undefined) ?? {}
        const fields: Record<string, string> = {}
        for (const change of object.modifications) {
          const target = changeTarget(meta.get(change.id), change, mods.levels, spellings)
          if (target === undefined) {
            unmapped.add(change.id)
            continue
          }
          fields[target.field] =
            target.element === undefined ? valueOf(change) : withElement(fields[target.field] ?? known[target.field] ?? '', target.element, valueOf(change))
        }
        add(kind.namespace, entityId, fields, source, custom ? base : undefined)
      }
    }
    if (unmapped.size > 0)
      diagnostics.push({
        severity: 'warning',
        code: 'blizzard.warcraft3/object-change-unmapped',
        message: `${document.path}: no metadata sheet names ${[...unmapped].slice(0, 8).join(', ')}${unmapped.size > 8 ? ' …' : ''}; those changes are left out`,
        source,
      })
    if (missingStrings.size > 0)
      diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/object-string-unresolved', message: `${document.path}: ${stringPath} does not resolve ${[...missingStrings].slice(0, 8).join(', ')}`, source })
  }
  const enumDocument = read.find(({ document }) => key(document.path) === 'ui/uniteditordata.txt')
  const enumTypes = enumDocument === undefined ? new Map() : readWar3EnumTypes(enumDocument.document.text, enumDocument.source, diagnostics)
  const enumFields = qualifyWar3EnumFields(typeNames, enumTypes, patches, diagnostics)
  // These are conservative admission subsets, not editor min/max constraints or native range
  // guarantees. Any invalid supplied patch sticks even when a later patch replaces its value.
  const numericFields = new Map<string, NonNullable<DataSchemaField['type']>>()
  if (suppliedDomainWithinBudget && metadataQualified &&
      !diagnostics.some(item => item.severity === 'error' || item.code === 'blizzard.warcraft3/data-sheet-unqualified')) {
    for (const [field, type] of typeNames)
      if (type === 'int' || type === 'real' || type === 'unreal')
        numericFields.set(field, type === 'int' ? { kind: 'number', integer: true } : { kind: 'number' })
    const observed = new Set<string>()
    for (const patch of patches) for (const [fieldId, raw] of Object.entries(patch.fields)) {
      const field = `${patch.namespace}/${fieldId}`
      const type = numericFields.get(field)
      if (type === undefined) continue
      observed.add(field)
      const integer = type.kind === 'number' && type.integer === true
      const grammar = integer ? /^[+-]?\d+$/u : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
      const value = typeof raw === 'string' && grammar.test(raw) ? Number(raw) : NaN
      // Number itself can underflow before fround sees the value. Inspect only the coefficient of
      // an already grammar-qualified decimal, so lexical zero and an extreme exponent stay zero.
      const underflowedToZero = value === 0 && typeof raw === 'string' && /[1-9]/u.test(raw.split(/[eE]/u, 1)[0]!)
      if (!Number.isFinite(value) || underflowedToZero || (integer ?
        !Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647 :
        !Number.isFinite(Math.fround(value)) || (value !== 0 && Math.fround(value) === 0)))
        numericFields.delete(field)
    }
    for (const field of numericFields.keys()) if (!observed.has(field)) numericFields.delete(field)
  }
  const schemas: DataTypeSchema[] = WAR3_DATA_KINDS.map(kind => ({
    typeId: kind.id,
    fields: [...fieldIds.get(kind.id)!].sort().map(fieldId => {
      const target = links.get(`${kind.id}/${fieldId}`)
      const type = enumFields.get(`${kind.id}/${fieldId}`) ?? numericFields.get(`${kind.id}/${fieldId}`)
      return { fieldId, cardinality: 'scalar' as const, ...(target == null ? {} : { linkNamespace: target }), ...(type === undefined ? {} : { type }) }
    }),
  }))
  return { patches, schemas, diagnostics }
}
