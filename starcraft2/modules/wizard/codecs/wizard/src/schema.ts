/**
 * The wizard checker's view of StarCraft II's catalog schema.
 *
 * It is a separate module, and not an import inside the codec, on purpose: the generated schema is
 * a 1.5 MB asset, and a codec that reads a 3 KB editor file has no business dragging it into every
 * browser worker that opens one. A host that has the schema loaded already — the data module, the
 * language service, a validation run — passes this adapter to `analyzeWizardDocument`, and the
 * catalog-aware rules switch on. Without it they stay off rather than guessing, which is what the
 * codec means when it reports `wizard.evaluate` as dependency-required.
 */
import {
  resolveStarcraft2SchemaFields,
  starcraft2NamespaceForType,
  STARCRAFT2_DATA_NAMESPACES,
  STARCRAFT2_SCHEMA_BY_TYPE,
} from '../../../../../modules/data/services/schema/full-data-schema.js'
import type { WizardSchema } from './core/analyze.js'

interface SchemaField {
  readonly fieldId: string
  readonly fields?: readonly SchemaField[]
  readonly recursiveStructure?: boolean
}

/**
 * Resolve an underscore-delimited field path against a type's fields.
 *
 * The format writes `WireframeVariations_Number` for a field inside a structure, and field names
 * themselves are CamelCase without underscores — but that is a convention, not a guarantee, so the
 * longest matching field name is tried first and the walk falls back to shorter ones. A structure
 * the schema records as recursive stops the walk and is accepted: the schema cannot expand it, and
 * reporting a path it declined to model as a mistake would blame the file for the schema's limit.
 */
function walk(fields: readonly SchemaField[], path: string): boolean {
  const candidates = fields
    .filter(field => path === field.fieldId || path.startsWith(`${field.fieldId}_`))
    .sort((left, right) => right.fieldId.length - left.fieldId.length)
  for (const candidate of candidates) {
    if (path === candidate.fieldId) return true
    const rest = path.slice(candidate.fieldId.length + 1)
    if (candidate.recursiveStructure === true) return true
    if (candidate.fields !== undefined && walk(candidate.fields, rest)) return true
  }
  return false
}

/*
 * Text fields the editor gives every data object, whether or not its catalog XML carries them
 * (`CSound`, `CRequirement`, `CDataCollectionUpgrade` do not). Evidence: `corpus` — 89 `field
 * id="Name"` and one `EditorPrefix`/`EditorSuffix` pair in the ScEvo wizards.
 */
const EDITOR_OBJECT_FIELDS = new Set(['Name', 'EditorPrefix', 'EditorSuffix'])

export function createStarcraft2WizardSchema(): WizardSchema {
  const namespaces = new Set<string>(STARCRAFT2_DATA_NAMESPACES as readonly string[])
  return {
    hasCatalog: name => namespaces.has(name),
    hasType: typeId => STARCRAFT2_SCHEMA_BY_TYPE.has(typeId),
    catalogForType: typeId => starcraft2NamespaceForType(typeId),
    hasFieldPath: (typeId, path) =>
      EDITOR_OBJECT_FIELDS.has(path) ||
      (path !== '' && walk(resolveStarcraft2SchemaFields(typeId) as readonly SchemaField[], path)),
  }
}
