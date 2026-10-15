/**
 * StarCraft II as a source of relation edges.
 *
 * `apps/modkit-vscode/src/relation-graph-data.ts` owned both halves of the graph: where edges come
 * from *and* how to walk them — depth, direction, kind filtering, node caps. The second half is
 * arithmetic that has nothing to do with any game, and it lives in `@modkitx/entity-cards` now.
 * This is the first half, and the only half a game should own.
 *
 * See `docs/tasks-active/entity-cards-strings/PLAN_wiki_subject_model.md` (W7).
 */

import type { RelationEdge, RelationEdgeProvider, SubjectRef } from '@modkit/codec-kit/legacy/entity-cards'

/** The slice of the legacy whole-mod relation graph this provider needs. */
export interface CatalogRelationSource {
  outgoing(namespace: string, id: string): readonly CatalogEntityRef[]
  incoming(namespace: string, id: string): readonly CatalogEntityRef[]
}

interface CatalogEntityLike {
  readonly namespace: string
  readonly id: string
  readonly name?: string
}

interface CatalogEntityRef {
  readonly from: CatalogEntityLike
  readonly to: CatalogEntityLike
  /** Dot-separated field path holding the reference, e.g. `WeaponArray.0.Link`. */
  readonly path: string
}

function subjectOfEntity(entity: CatalogEntityLike): SubjectRef {
  return { kind: entity.namespace, id: entity.id }
}

function edgeOf(ref: CatalogEntityRef): RelationEdge {
  return {
    from: subjectOfEntity(ref.from),
    to: subjectOfEntity(ref.to),
    // The field path is what makes an edge meaningful to a modder: "referenced from
    // WeaponArray.0.Link" says something "references" never could.
    relation: ref.path,
  }
}

/**
 * Adapt a catalog relation graph to the game-neutral provider.
 *
 * `labels` is optional because the graph itself carries ids, not display names; a host with a
 * loaded catalog can supply them, and without it the traversal falls back to ids rather than
 * failing.
 */
export function createCatalogRelationProvider(
  source: CatalogRelationSource,
  labels?: (subject: SubjectRef) => string | undefined,
): RelationEdgeProvider {
  return {
    outgoing: subject => source.outgoing(subject.kind, subject.id).map(edgeOf),
    incoming: subject => source.incoming(subject.kind, subject.id).map(edgeOf),
    ...(labels ? { label: labels } : {}),
  }
}
