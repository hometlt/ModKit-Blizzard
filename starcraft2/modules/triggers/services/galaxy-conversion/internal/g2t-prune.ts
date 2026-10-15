/**
 * g2t-prune — removes speculative orphan elements before serialization.
 *
 * mkParamRef / mkFCRef register elements into ctx.elements immediately; any
 * tryBuild* matcher that creates child params/calls and then bails (returning
 * undefined so the caller falls back to custom script or another pattern)
 * leaves those children behind. Serializing them produces top-level <Element>
 * nodes no parent references — the editor logs
 *   "Orphaned trigger parameter removed ..." /
 *   "Orphaned trigger function call removed ..."
 * and deletes them, which can cascade into real data loss.
 *
 * This pass keeps every non-Param/non-FunctionCall element as a root (Trigger,
 * FunctionDef, Variable, ParamDef, Structure, ...) and drops any Param or
 * FunctionCall element not reachable from a root through element refs.
 */

import type { ElementJson } from '../../../shared/trigger-document/index.js';

const PRUNABLE_TYPES = new Set(['Param', 'FunctionCall']);

/** True for objects that look like an element ref: { type, id [, library] }. */
function isElementRefLike(v: any): v is { type: string; id: string; library?: string } {
  return v && typeof v === 'object' && typeof v.type === 'string' && typeof v.id === 'string';
}

function referencedLocalElements(
  node: unknown,
  elements: Record<string, ElementJson>,
  libId: string,
): ElementJson[] {
  const references: ElementJson[] = [];
  const pending: unknown[] = [node];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (isElementRefLike(value)) {
      const sameLib = value.library === undefined || value.library === libId;
      const target = sameLib ? elements[value.id] : undefined;
      if (target?.type === value.type) references.push(target);
      // Element references have no inline owned payload. Following their target
      // is the outer graph walk's responsibility and avoids conflating a full
      // element object with a reference to itself.
      continue;
    }
    pending.push(...Object.entries(value)
      .filter(([key]) => key !== 'type' && key !== 'id' && key !== 'library')
      .map(([, child]) => child));
  }
  return references;
}

export interface PruneResult {
  removedIds: string[];
}

/**
 * Mutates `elements`, deleting unreachable Param/FunctionCall elements.
 * Returns the removed ids (useful for diagnostics/tests).
 */
export function pruneUnreachableElements(
  elements: Record<string, ElementJson>,
  libId: string,
): PruneResult {
  const reachable = new Set<string>();
  const pending: ElementJson[] = [];

  // Roots: everything that is not a Param/FunctionCall. Traverse the element
  // graph explicitly; marking an id and scanning its outgoing edges are two
  // separate operations, so a shared/cyclic node cannot suppress its children.
  for (const el of Object.values(elements)) {
    if (PRUNABLE_TYPES.has(el.type)) continue;
    reachable.add(el.id);
    pending.push(el);
  }
  const scanned = new Set<string>();
  while (pending.length) {
    const owner = pending.pop()!;
    const ownerKey = `${owner.type}:${owner.id}`;
    if (scanned.has(ownerKey)) continue;
    scanned.add(ownerKey);
    for (const [key, value] of Object.entries(owner)) {
      if (key === 'type' || key === 'id' || key === 'library') continue;
      for (const target of referencedLocalElements(value, elements, libId)) {
        reachable.add(target.id);
        pending.push(target);
      }
    }
  }

  const removedIds: string[] = [];
  for (const id of Object.keys(elements)) {
    const el = elements[id];
    if (PRUNABLE_TYPES.has(el.type) && !reachable.has(id)) {
      removedIds.push(id);
      delete elements[id];
    }
  }
  return { removedIds };
}
