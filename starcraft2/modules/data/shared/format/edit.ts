/**
 * `sc2-data`'s real `edit.content` surface: a validated `AssetEditTransaction` (canonical
 * architecture section 5.5) for schema-driven catalog **entity rename**, built on the pure
 * transform in `./entity-rename.js`.
 *
 * This is the first of the four per-domain rename transactions the Phase D acceptance criterion
 * "cross-codec rename applies one validated mod-level edit transaction" needs: `sc2-data` owns
 * catalog source edits, `sc2-mod` will coordinate the cross-codec transaction over this one plus
 * the still-unconsolidated trigger (item 4), layout (item 5), and map (item 7) halves that
 * `@modkitx/ops`'s `renameEntities()` still drives directly. See `packages/assets/src/editing.ts`
 * ("`sc2-data` owns catalog source edits, `sc2-mod` coordinates cross-codec edit transactions").
 *
 * Honesty notes, all surfaced as structured diagnostics rather than silently accepted:
 *
 * - **The plan never mutates the open document.** Both the baseline and the renamed catalog are
 *   built from `structuredClone`d parsed entries, so a host can inspect a plan and discard it.
 *   Only `@modkitx/ops`'s legacy in-place `renameEntities()` mutates.
 * - **Re-serialization is not byte-preserving.** Each edited GameData file is rebuilt from its
 *   parsed entries through `entity-xml.js`, which drops comments, original attribute ordering,
 *   and whitespace. Reported by {@link SC2_DATA_ENTITY_RENAME_RESERIALIZED_DIAGNOSTIC_ID} and
 *   `preservesUnknownData: false`.
 * - **An id declared in more than one loaded file cannot be split back apart.** The catalog
 *   merges those declarations into one entity, so re-emitting per file would duplicate the merged
 *   fields into each. Rejected as an error
 *   ({@link SC2_DATA_ENTITY_RENAME_MULTI_FILE_DIAGNOSTIC_ID}) instead of silently corrupting.
 * - **An incomplete inheritance chain under-patches.** `<?token?>` declarations and `parent=`
 *   targets live on ancestors; when an ancestor is outside the loaded set, token-typed attributes
 *   are not recognized as links at all. Reported by
 *   {@link SC2_DATA_ENTITY_RENAME_CHAIN_INCOMPLETE_DIAGNOSTIC_ID}, and `describe()` degrades the
 *   whole operation to `dependency-required` in that state.
 */

import {
  Sc2EditInputError,
  type RenameEditPlan,
  type RenameEditTransaction,
  type RenameFinding,
  type RenameOutput,
  type RenameSourceEdit,
} from '../../../../shared/editing/rename-transaction.js'
import { TypedCatalog } from '../catalog-engine/sc2-catalog/index.js'
import { typeToNamespace } from '../catalog-engine/sc2-schema/index.js'
import type { ParsedCatalogFile } from '../catalog-engine/xml/index.js'
import { constEntryToXml, entityToXml } from './entity-xml.js'
import {
  renameCatalogEntities,
  type CatalogRenameResult,
  type CatalogRenameSpec,
  type CatalogTextReference,
} from './entity-rename.js'
import {
  catalogStructureDefaults,
  loadCatalogFiles,
  STARCRAFT2_STRUCTURE_DEFAULT_RULES,
  type LoadedCatalogFile,
  type Sc2DataDocument,
} from './document.js'
import { SC2_DATA_CODEC_ID } from './identity.js'

/** JSON-serializable input accepted by the `sc2-data` `edit.content` (entity-rename) handler. */
export interface Sc2DataEntityRenameInput {
  /** The renames to apply. `newId` may contain `*` as a placeholder for the current id. */
  readonly renames: readonly CatalogRenameSpec[]
  /**
   * Localized-string keys referenced by each entity, when the host has a relation graph. Enables
   * the old-parser `resolveText` mask behavior; omit to skip it.
   */
  readonly textReferences?: readonly CatalogTextReference[]
  /** Indentation for the re-serialized GameData XML. Default: four spaces. */
  readonly indent?: string
}

export const SC2_DATA_ENTITY_RENAME_UNKNOWN_ENTITY_DIAGNOSTIC_ID =
  'sc2-data.edit.entity-rename.unknown-entity'
export const SC2_DATA_ENTITY_RENAME_ID_COLLISION_DIAGNOSTIC_ID =
  'sc2-data.edit.entity-rename.id-collision'
export const SC2_DATA_ENTITY_RENAME_MULTI_FILE_DIAGNOSTIC_ID =
  'sc2-data.edit.entity-rename.multi-file-entity'
export const SC2_DATA_ENTITY_RENAME_RESERIALIZED_DIAGNOSTIC_ID =
  'sc2-data.edit.entity-rename.reserialized'
export const SC2_DATA_ENTITY_RENAME_CHAIN_INCOMPLETE_DIAGNOSTIC_ID =
  'sc2-data.edit.entity-rename.chain-incomplete'
export const SC2_DATA_ENTITY_RENAME_NO_OP_DIAGNOSTIC_ID = 'sc2-data.edit.entity-rename.no-op'

function fail(message: string, context: Record<string, unknown> = {}): never {
  throw new Sc2EditInputError(message, {
    codecId: SC2_DATA_CODEC_ID,
    operation: 'edit.content',
    ...context,
  })
}

function isRenameSpec(value: unknown): value is CatalogRenameSpec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { namespace, oldId, newId } = value as Record<string, unknown>
  return (
    typeof namespace === 'string' &&
    namespace.trim() !== '' &&
    typeof oldId === 'string' &&
    typeof newId === 'string' &&
    newId.trim() !== ''
  )
}

function isTextReference(value: unknown): value is CatalogTextReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { from, key } = value as Record<string, unknown>
  if (typeof key !== 'string') return false
  if (from === null || typeof from !== 'object' || Array.isArray(from)) return false
  const { namespace, id } = from as Record<string, unknown>
  return typeof namespace === 'string' && typeof id === 'string'
}

/** Validates and normalizes the JSON operation input received over a session handler. */
export function parseSc2DataEntityRenameInput(input: unknown): Sc2DataEntityRenameInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('sc2-data edit.content (entity-rename) input must be an object with a `renames` array.')
  }
  const { renames, textReferences, indent } = input as Record<string, unknown>
  if (!Array.isArray(renames) || renames.length === 0 || !renames.every(isRenameSpec)) {
    fail(
      'sc2-data edit.content (entity-rename) requires a non-empty `renames` array of ' +
        '{ namespace, oldId, newId } objects with non-empty `namespace` and `newId`.',
    )
  }
  if (
    textReferences !== undefined &&
    (!Array.isArray(textReferences) || !textReferences.every(isTextReference))
  ) {
    fail(
      'sc2-data edit.content (entity-rename) `textReferences` must be an array of ' +
        '{ from: { namespace, id }, key } objects.',
    )
  }
  if (indent !== undefined && typeof indent !== 'string') {
    fail('sc2-data edit.content (entity-rename) `indent` must be a string.')
  }
  return {
    renames: (renames as CatalogRenameSpec[]).map(spec => ({
      namespace: spec.namespace,
      oldId: spec.oldId,
      newId: spec.newId,
    })),
    ...(textReferences === undefined
      ? {}
      : {
          textReferences: (textReferences as CatalogTextReference[]).map(ref => ({
            from: { namespace: ref.from.namespace, id: ref.from.id },
            key: ref.key,
          })),
        }),
    ...(indent === undefined ? {} : { indent }),
  }
}

// --- catalog cloning + per-file re-serialization -------------------------------------------

interface ClonedCatalog {
  readonly catalog: TypedCatalog
  readonly files: readonly LoadedCatalogFile[]
}

/**
 * Rebuild a document's catalog from deep-cloned parsed entries.
 *
 * `TypedCatalog` stores single-declaration entries by reference (`buildEntity(..., entry.fields,
 * ...)`), so a rename over a catalog loaded from the document's own `parsed` data would mutate
 * the open document. Cloning first is what makes the plan inspectable without side effects.
 */
function cloneCatalog(document: Sc2DataDocument): ClonedCatalog {
  const files = document.files.map(file => ({
    ...file,
    parsed: structuredClone(file.parsed) as ParsedCatalogFile,
  }))
  const catalog = new TypedCatalog({
    schema: document.schema,
    structureDefaults: STARCRAFT2_STRUCTURE_DEFAULT_RULES,
  })
  loadCatalogFiles(catalog, files)
  return { catalog, files }
}

/** Namespace of a parsed entry's root type, matching how `TypedCatalog` keys its store. */
function entryNamespace(type: string): string {
  return typeToNamespace(type) ?? type.slice(1)
}

/**
 * Serialize one loaded file back to a complete `<Catalog>` document, taking each entity's current
 * state from `catalog`. Entries keep their in-file grouping order; formatting is normalized.
 */
function serializeFile(
  file: LoadedCatalogFile,
  catalog: TypedCatalog,
  mapped: CatalogRenameResult['mapped'],
  indent: string,
): string {
  const lines: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Catalog>']
  // Root structure defaults (`<SCost>`) are not entries; keep them verbatim so a rewrite never drops them.
  for (const structureDefault of catalogStructureDefaults(file.text)) {
    lines.push(`${indent}${structureDefault.text}`)
  }
  for (const [type, entries] of file.parsed.entries) {
    const namespace = entryNamespace(type)
    for (const entry of entries) {
      const id = mapped(namespace, entry.id) ?? entry.id
      const entity = catalog.get(namespace, id)
      if (entity === undefined) continue
      if (namespace === 'Const') {
        const constType = typeof entity.data['type'] === 'string' ? entity.data['type'] : ''
        const value = typeof entity.data['value'] === 'string' ? entity.data['value'] : ''
        lines.push(constEntryToXml(entity.id, constType, value, indent))
      } else {
        lines.push(
          entityToXml(entity.class, entity.id, entity.parent, entity.data, entity.id === '', {
            indent,
            writeDefaultAttr: true,
          }),
        )
      }
    }
  }
  lines.push('</Catalog>')
  return lines.join('\n') + '\n'
}

/** Ids declared by more than one of the loaded files (the merge case a plan cannot split). */
function multiFileEntities(files: readonly LoadedCatalogFile[]): string[] {
  const seen = new Map<string, number>()
  for (const file of files) {
    const local = new Set<string>()
    for (const [type, entries] of file.parsed.entries) {
      const namespace = entryNamespace(type)
      for (const entry of entries) local.add(`${namespace}/${entry.id}`)
    }
    for (const key of local) seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key)
}

// --- plan ------------------------------------------------------------------------------------

interface PreparedRename {
  readonly result: CatalogRenameResult
  readonly edits: readonly RenameSourceEdit[]
  /** One per edit, in the same order: the re-serialized file addressed by its logical path. */
  readonly outputs: readonly RenameOutput[]
  readonly diagnostics: readonly RenameFinding[]
}

function prepare(document: Sc2DataDocument, input: Sc2DataEntityRenameInput): PreparedRename {
  const diagnostics: RenameFinding[] = []
  const indent = input.indent ?? '    '

  // Targets must exist, and the requested new ids must not already be taken.
  for (const spec of input.renames) {
    const entity = document.catalog.get(spec.namespace, spec.oldId)
    if (entity === undefined) {
      diagnostics.push({
        id: SC2_DATA_ENTITY_RENAME_UNKNOWN_ENTITY_DIAGNOSTIC_ID,
        severity: 'error',
        code: 'sc2-data.edit.entity-rename.unknown-entity',
        category: 'malformed',
        message: `No '${spec.namespace}' entity '${spec.oldId}' is present in the loaded catalog.`,
        source: SC2_DATA_CODEC_ID,
        detail: { namespace: spec.namespace, id: spec.oldId },
      })
      continue
    }
    const newId = spec.newId.replace('*', spec.oldId)
    if (newId !== spec.oldId && document.catalog.get(spec.namespace, newId) !== undefined) {
      diagnostics.push({
        id: SC2_DATA_ENTITY_RENAME_ID_COLLISION_DIAGNOSTIC_ID,
        severity: 'error',
        code: 'sc2-data.edit.entity-rename.id-collision',
        category: 'malformed',
        message: `Renaming '${spec.namespace}/${spec.oldId}' to '${newId}' would collide with an existing entity.`,
        source: SC2_DATA_CODEC_ID,
        detail: { namespace: spec.namespace, oldId: spec.oldId, newId },
      })
    }
  }

  const shared = multiFileEntities(document.files)
  if (shared.length > 0) {
    diagnostics.push({
      id: SC2_DATA_ENTITY_RENAME_MULTI_FILE_DIAGNOSTIC_ID,
      severity: 'error',
      code: 'sc2-data.edit.entity-rename.multi-file-entity',
      category: 'partial-support',
      message:
        `${shared.length} entit${shared.length === 1 ? 'y is' : 'ies are'} declared in more than ` +
        'one loaded GameData file. The catalog merges those declarations into one entity, so ' +
        'this codec cannot re-emit them per file without duplicating the merged fields. Edit ' +
        'the files individually instead.',
      source: SC2_DATA_CODEC_ID,
      detail: { entities: shared.slice(0, 10), count: shared.length },
    })
  }

  if (document.stats.unresolvedParents.length > 0) {
    diagnostics.push({
      id: SC2_DATA_ENTITY_RENAME_CHAIN_INCOMPLETE_DIAGNOSTIC_ID,
      severity: 'warning',
      category: 'partial-support',
      code: 'sc2-data.edit.entity-rename.chain-incomplete',
      message:
        `${document.stats.unresolvedParents.length} loaded entit` +
        `${document.stats.unresolvedParents.length === 1 ? 'y inherits' : 'ies inherit'} from an ` +
        'ancestor outside this document set. `<?token?>` declarations and `parent=` targets live ' +
        'on ancestors, so token-typed attributes referencing a renamed entity may go unpatched. ' +
        'Open the full dependency chain through a GameContentResolver before renaming.',
      source: SC2_DATA_CODEC_ID,
      detail: { unresolved: document.stats.unresolvedParents.length },
    })
  }

  // Baseline and renamed serializations, both from throwaway clones.
  const baseline = cloneCatalog(document)
  const target = cloneCatalog(document)
  const result = renameCatalogEntities(target.catalog, input.renames, {
    ...(input.textReferences === undefined ? {} : { textReferences: input.textReferences }),
  })

  const noop = (): string | undefined => undefined
  const edits: RenameSourceEdit[] = []
  const outputs: RenameOutput[] = []
  const encoder = new TextEncoder()
  for (let index = 0; index < target.files.length; index++) {
    const file = target.files[index]!
    const before = serializeFile(baseline.files[index]!, baseline.catalog, noop, indent)
    const after = serializeFile(file, target.catalog, result.mapped, indent)
    if (before === after) continue
    edits.push({
      sourceId: file.sourceId ?? file.path,
      operation: 'replace',
      range: { offset: 0, length: encoder.encode(file.text).byteLength },
      text: after,
      label: `Rename catalog entities in ${file.path}`,
    })
    outputs.push({
      path: file.path,
      data: encoder.encode(after),
      mediaType: 'application/xml',
      role: 'sc2-data',
    })
  }

  if (edits.length === 0) {
    diagnostics.push({
      id: SC2_DATA_ENTITY_RENAME_NO_OP_DIAGNOSTIC_ID,
      severity: 'info',
      category: 'malformed',
      code: 'sc2-data.edit.entity-rename.no-op',
      message: 'The requested rename changes nothing in the loaded GameData files.',
      source: SC2_DATA_CODEC_ID,
    })
  } else {
    diagnostics.push({
      id: SC2_DATA_ENTITY_RENAME_RESERIALIZED_DIAGNOSTIC_ID,
      severity: 'warning',
      category: 'partial-support',
      code: 'sc2-data.edit.entity-rename.reserialized',
      message:
        `${edits.length} GameData file(s) are rebuilt from parsed entries, so XML comments, ` +
        'original attribute ordering, and whitespace are normalized rather than preserved.',
      source: SC2_DATA_CODEC_ID,
      detail: { files: edits.length },
    })
  }

  return { result, edits, outputs, diagnostics }
}

/** An `RenameEditPlan` that also reports what the catalog transform actually touched. */
export interface Sc2DataEntityRenameEditPlan extends RenameEditPlan {
  /** Counts and rename handles from the pure transform, for a host's confirmation UI. */
  readonly summary: {
    readonly entitiesRenamed: number
    readonly referencesPatched: number
    readonly stringsRenamed: number
    readonly textKeyRenames: Readonly<Record<string, string>>
  }
}

/**
 * Builds the `RenameEditPlan` for the `edit.content` (entity-rename) operation: one `replace` edit
 * per loaded GameData file whose serialization changed, plus the structured diagnostics above.
 */
export function createSc2DataEntityRenameEditPlan(
  document: Sc2DataDocument,
  input: Sc2DataEntityRenameInput,
): Sc2DataEntityRenameEditPlan {
  return toPlan(prepare(document, input))
}

function toPlan(prepared: PreparedRename): Sc2DataEntityRenameEditPlan {
  return {
    edits: prepared.edits,
    diagnostics: prepared.diagnostics,
    // Files are rebuilt from parsed entries, never spliced byte-for-byte.
    preservesUnknownData: false,
    summary: {
      entitiesRenamed: prepared.result.entitiesRenamed,
      referencesPatched: prepared.result.referencesPatched,
      stringsRenamed: prepared.result.stringsRenamed,
      textKeyRenames: Object.fromEntries(prepared.result.textKeyRenames),
    },
  }
}

/** An `AssetEditTransaction` that also exposes the finalized `RenameOutput`s once applied. */
export type Sc2DataEntityRenameEditTransaction = RenameEditTransaction<Sc2DataEntityRenameEditPlan>

export function createSc2DataEntityRenameEditTransaction(
  document: Sc2DataDocument,
  input: Sc2DataEntityRenameInput,
): Sc2DataEntityRenameEditTransaction {
  const prepared = prepare(document, input)
  const plan = toPlan(prepared)
  let applied: readonly RenameOutput[] | undefined

  return {
    plans: [plan],

    async validate(): Promise<void> {
      const errors = plan.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
      if (errors.length > 0) {
        fail(
          `sc2-data edit.content (entity-rename) is invalid: ${errors
            .map(error => error.message)
            .join('; ')}`,
          { diagnosticIds: errors.map(error => error.id) },
        )
      }
    },

    async apply(): Promise<void> {
      applied = prepared.outputs
    },

    outputs(): readonly RenameOutput[] {
      if (applied === undefined) {
        fail('Call apply() before requesting the sc2-data entity-rename edit outputs.')
      }
      return applied
    },
  }
}
