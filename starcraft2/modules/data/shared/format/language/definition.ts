/**
 * Pure go-to-definition core. Given a cursor offset, determine which entity a
 * `parent="…"` attribute or an `isLink` field value points at; and locate an entity
 * definition's offset within a target document. No vscode import.
 */

import { elementPathAt, attrAt, getAttr, scanXml, type ScannedElement } from './xml-scan.js'
import { lookupField, classifyField } from '../../catalog-engine/sc2-catalog/index.js'
import { schemaForPath, attrType } from './completion.js'
import { entityPath, catalogEntities } from './entity.js'
import { instructionTargetAt } from './references.js'

export type DefinitionRequest =
  | { kind: 'parent'; id: string; entityClass: string; entityId: string }
  | { kind: 'link'; namespace: string; id: string }
  /** A localized-text key (`CStringLink` field) — resolves to the key's line in a locale file. */
  | { kind: 'text'; key: string }
  /** An asset path (`CFile` / file link) — resolves to the asset file. */
  | { kind: 'file'; path: string }

/** What entity/text/asset (if any) the symbol under `offset` references. */
export function definitionRequestAt(text: string, offset: number): DefinitionRequest | undefined {
  const path = entityPath(elementPathAt(text, offset))
  if (path.length === 0) return undefined
  const entity = path[0]!

  for (let i = path.length - 1; i >= 0; i--) {
    const el = path[i]!
    const a = attrAt(el, offset)
    if (!a || !a.value) continue

    // parent="X" → another entity in the same namespace as this entity.
    if (a.name === 'parent') {
      return {
        kind: 'parent',
        id: a.value,
        entityClass: entity.tag,
        entityId: getAttr(entity, 'id')?.value ?? '',
      }
    }

    // value="X" / Link="X" on a field element whose type is an entity/text/file link
    // or a catalog reference.
    if (i >= 1 && (a.name === 'value' || a.name === 'Link')) {
      const parentSchema = schemaForPath(path.slice(0, i))
      if (!parentSchema) return undefined
      const ft = lookupField(parentSchema, el.tag)
      if (ft === undefined) return undefined
      const info = attrType(classifyField(ft), a.name)
      if (!info) return undefined
      if (info.kind === 'link' && info.linkNamespace && !info.isTextLink && !info.isFileLink) {
        return { kind: 'link', namespace: info.linkNamespace, id: a.value }
      }
      if (info.kind === 'link' && info.isTextLink) return { kind: 'text', key: a.value }
      if (info.kind === 'file' || (info.kind === 'link' && info.isFileLink)) {
        return a.value.startsWith('@') ? undefined : { kind: 'file', path: a.value }
      }
      // Catalog reference "Ns,Entry[,Field]" → the Entry entity in namespace Ns.
      if (info.kind === 'catalogRef') {
        const parts = a.value.split(',')
        if (parts.length >= 2 && parts[0] && parts[1]) {
          return { kind: 'link', namespace: parts[0], id: parts[1] }
        }
      }
      return undefined
    }

    // Instruction scalars (actor `Send`/`Terms`, …): jump from the arg token under the
    // cursor to the entity it names (e.g. `ModelSwap <Model>` → the CModel definition).
    const elemSchema = schemaForPath(path.slice(0, i + 1))
    const ift = elemSchema ? lookupField(elemSchema, a.name) : undefined
    const iinfo = ift !== undefined ? classifyField(ift) : undefined
    if (
      iinfo?.kind === 'instructions' &&
      iinfo.instructions &&
      iinfo.instructionDelimiter === ' '
    ) {
      const t = instructionTargetAt(iinfo, a, offset)
      if (t) return { kind: 'link', namespace: t.namespace, id: t.id }
    }
    return undefined
  }
  return undefined
}

/**
 * Offset of the opening tag of the top-level entity with id `id` (optionally of a
 * given class) in `text`, or undefined. Used to position a Location in the target
 * document after resolving which file an entity lives in.
 */
export function locateEntityOffset(
  text: string,
  id: string,
  classTag?: string,
): number | undefined {
  let fallback: number | undefined
  for (const el of catalogEntities(scanXml(text))) {
    if ((getAttr(el, 'id')?.value ?? '') !== id) continue
    if (classTag === undefined || el.tag === classTag) return el.tagStart
    fallback ??= el.tagStart
  }
  return fallback
}

export type { ScannedElement }
