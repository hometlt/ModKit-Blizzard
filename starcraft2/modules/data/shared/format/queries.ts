/**
 * `sc2-data` read operations over a loaded catalog document: query, inheritance, references,
 * validation and export. Shared by the native codec and the legacy `Sc2DataCodec` oracle; free of
 * legacy asset DTOs apart from the export transform's output type.
 */

import type { RawFields } from '../catalog-engine/xml/index.js'
import { type CatalogEntity, buildChain } from '../catalog-engine/sc2-catalog/index.js'
import { catalogConstAliases, collectIssues, type Issue } from './language/diagnostics.js'
import { findReferences, type RefMatch } from './language/references.js'
import type { Sc2DataDocument } from './document.js'
import { exportCatalogOutputs, type Sc2DataExportInput } from './export.js'

/** One entity as returned by the browse/query operation. */
export interface CatalogEntitySummary {
  readonly namespace: string
  readonly id: string
  readonly class: string
  readonly parent?: string
  /** Declaration sites in load order, when the parser tracked them. */
  readonly sources: readonly {
    readonly mod: string
    readonly file: string
    readonly line?: number
  }[]
}

export interface CatalogQuery {
  /** Restrict to one namespace, e.g. `Unit`. */
  readonly namespace?: string
  /** Case-insensitive substring match against the entity id. */
  readonly id?: string
  /** Restrict to one C-prefixed class, e.g. `CActorUnit`. */
  readonly class?: string
  /** Cap on returned rows; omit for all matches. */
  readonly limit?: number
}

/** Result of resolving one entity's inheritance chain. */
export interface ResolvedEntity {
  readonly namespace: string
  readonly id: string
  /** Merged fields, parent chain applied and tokens substituted. */
  readonly fields: RawFields
  /** Ancestors that were merged, root first. */
  readonly chain: readonly string[]
  /**
   * True when an ancestor named by the chain was not present in the loaded set, so `fields` is
   * partially merged. Mirrors the descriptor's `structure.hierarchy: partial` state.
   */
  readonly partial: boolean
}

function summarize(namespace: string, entity: CatalogEntity): CatalogEntitySummary {
  return {
    namespace,
    id: entity.id,
    class: entity.class,
    ...(entity.parent === undefined ? {} : { parent: entity.parent }),
    sources: (entity.sources ?? (entity.source ? [entity.source] : [])).map(source => ({
      mod: source.mod,
      file: source.file,
      ...(source.line === undefined ? {} : { line: source.line }),
    })),
  }
}

/** Native-facing catalog query shared with the compatibility codec class. */
export function querySc2Data(
  document: Sc2DataDocument,
  query: CatalogQuery = {},
): readonly CatalogEntitySummary[] {
  const namespaces = query.namespace ? [query.namespace] : document.catalog.namespaces()
  const needle = query.id?.toLowerCase()
  const results: CatalogEntitySummary[] = []
  for (const namespace of namespaces) {
    for (const entity of document.catalog.all(namespace)) {
      if (query.class !== undefined && entity.class !== query.class) continue
      if (needle !== undefined && !entity.id.toLowerCase().includes(needle)) continue
      results.push(summarize(namespace, entity))
      if (query.limit !== undefined && results.length >= query.limit) return results
    }
  }
  return results
}

/** Resolve inheritance without exposing the compatibility operation session. */
export function resolveSc2DataInheritance(
  document: Sc2DataDocument,
  namespace: string,
  id: string,
): ResolvedEntity | undefined {
  const entity = document.catalog.get(namespace, id)
  if (entity === undefined) return undefined
  const fields = document.catalog.getResolved(namespace, id)
  if (fields === undefined) return undefined
  const chain = buildChain(entity, (ns, eid) => document.catalog.get(ns, eid))
  const root = chain[0]
  return {
    namespace,
    id,
    fields,
    chain: chain.map(link => link.id),
    partial: root?.parent !== undefined,
  }
}

/** Find positional references in the loaded catalog snapshot. */
export function findSc2DataReferences(
  document: Sc2DataDocument,
  namespace: string,
  id: string,
  includeDeclaration = true,
): readonly RefMatch[] {
  const matches: RefMatch[] = []
  for (const file of document.files) {
    matches.push(...findReferences(file.text, { namespace, id }, includeDeclaration))
  }
  return matches
}

/** Validate the loaded catalog against its schema and reference set. */
export function validateSc2Data(document: Sc2DataDocument): readonly Issue[] {
  const catalogHas = (namespace: string, id: string): boolean =>
    document.catalog.get(namespace, id) !== undefined
  const issues: Issue[] = []
  const refs = { isConstAlias: catalogConstAliases(document.files.map(file => file.text)) }
  for (const file of document.files) {
    issues.push(...collectIssues(file.text, catalogHas, undefined, file.path, refs))
  }
  return issues
}

/** Export through the domain transform without entering a legacy operation session. */
export function exportSc2DataCatalog(
  document: Sc2DataDocument,
  input: Sc2DataExportInput = {},
): ReturnType<typeof exportCatalogOutputs> {
  return exportCatalogOutputs(document.catalog, input)
}

