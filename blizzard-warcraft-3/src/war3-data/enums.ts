/**
 * WC3 qualified scalar editor declarations from optional UI/UnitEditorData.txt, parsed by codec-kit's INI
 * owner. NumValues selects zero-padded numbered rows; only their native ID is a member, not the
 * display-string key or additional columns. Labels/localization, mode filtering and numeric types are not
 * inferred. Native unset strings use the common enum unknown marker, not invented members.
 * Malformed domains or non-scalar/unlisted values remain untyped without changing data.
 * The catalog owner supplies bounded documents/provenance; this helper has no I/O or writer.
 * Published through DataSchemaField.type, not a second schema/editor contract.
 * Canonical declaration: providers/war3-data/provider.json.
 */
import type { DataCatalogDiagnostic, DataEntityPatch, DataSchemaField } from '@modkit/sdk/data'
import { decodeInput, parseIni } from '@modkit/codec-kit/text'

type EnumType = Extract<NonNullable<DataSchemaField['type']>, { kind: 'enum' }>

// Other editor domains include bitmasks and multi-value fields; table membership alone is not
// evidence of scalar semantics. Extend this native classification only with a qualified consumer.
// UnitBalance/UnitWeapons scalar metadata and string consumers corroborate these domains;
// members still come only from the selected UED, never reference-engine aliases or defaults.
const SCALAR_ENUM_TYPES: ReadonlySet<string> = new Set([
  'unitRace', 'moveType', 'defenseType', 'weaponType', 'attackType', 'attributeType', 'regenType',
])

/** Read the declared native members once; malformed sections never fall back to an older file. */
export function readWar3EnumTypes(text: string, source: DataEntityPatch['source'], diagnostics: DataCatalogDiagnostic[]): ReadonlyMap<string, EnumType> {
  const types = new Map<string, EnumType>()
  const sections = new Set<string>()
  const parsed = parseIni(decodeInput({ text }), 'ini-war3')
  if (parsed.state === 'failed') {
    diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-enums-unreadable', message: `${source.path}: editor enum document is not readable INI`, source })
    return types
  }
  for (const section of parsed.document.sections) {
    if (!SCALAR_ENUM_TYPES.has(section.name)) continue
    if (sections.has(section.name)) {
      types.delete(section.name)
      diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-enum-unqualified', message: `${source.path}: repeated enum section ${section.name} is not qualified`, source })
      continue
    }
    sections.add(section.name)
    const entries = new Map(section.entries.map(entry => [entry.key, entry.value]))
    if (entries.size !== section.entries.length) {
      diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-enum-unqualified', message: `${source.path}: ${section.name} has repeated enum keys with unqualified precedence`, source })
      continue
    }
    const rawCount = entries.get('NumValues')
    if (rawCount === undefined) continue
    const count = /^\d+$/u.test(rawCount) ? Number(rawCount) : NaN
    // The document must actually contain the rows; a hostile count cannot drive allocation/work.
    const validCount = Number.isSafeInteger(count) && count >= 0 && count <= entries.size
    const members: { id: string }[] = []
    const seen = new Set<string>()
    if (validCount) for (let index = 0; index < count; index += 1) {
      const value = entries.get(String(index).padStart(2, '0'))
      const id = value?.split(',')[0]?.trim()
      if (id === undefined || id === '' || id.includes('"') || seen.has(id)) break
      seen.add(id)
      members.push({ id })
    }
    if (!validCount || members.length !== count) {
      diagnostics.push({ severity: 'warning', code: 'blizzard.warcraft3/data-enum-unqualified', message: `${source.path}: ${section.name} does not declare a complete, unique native enum`, source })
      continue
    }
    if (members.length > 0) types.set(section.name, { kind: 'enum', members })
  }
  return types
}

/** A universal scalar enum is published only when all authored values match its native domain. */
export function qualifyWar3EnumFields(
  names: ReadonlyMap<string, string | null>,
  types: ReadonlyMap<string, EnumType>,
  patches: readonly DataEntityPatch[],
  diagnostics: DataCatalogDiagnostic[],
): ReadonlyMap<string, EnumType> {
  const domains = new Map([...types].map(([name, type]) => [name, { type, ids: new Set(type.members.map(member => member.id)) }]))
  const fields = new Map([...names].flatMap(([key, name]) => {
    const domain = name === null ? undefined : domains.get(name)
    return domain === undefined ? [] : [[key, domain] as const]
  }))
  for (const patch of patches) for (const [fieldId, value] of Object.entries(patch.fields)) {
    const key = `${patch.namespace}/${fieldId}`
    const domain = fields.get(key)
    if (domain === undefined || (typeof value === 'string' && domain.ids.has(value))) continue
    if (value === '' || value === '_' || value === '-') {
      fields.set(key, { ...domain, type: { ...domain.type, unknown: 'Native unset value' } })
      continue
    }
    fields.delete(key)
    diagnostics.push({
      severity: 'information', code: 'blizzard.warcraft3/data-enum-value-unqualified',
      message: `${fieldId}: a value is not represented by its native scalar enum; retaining the field untyped`,
      namespace: patch.namespace, entityId: patch.entityId, fieldId, source: patch.source,
    })
  }
  return new Map([...fields].map(([key, domain]) => [key, domain.type]))
}
