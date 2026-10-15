/**
 * One field write into the XML that declares an entity: what a GameData file session and a mod
 * session both answer `edit.field` with (parity plan 5.3), through the one raw-preserving patcher.
 */
import { patchCatalogField } from './catalog-field-patch.js'

/** `xml` with `field` of `entityId` set to `value` (`null` removes it); throws when nothing changes. */
export function writeEntityField(
  xml: string,
  entityClass: string,
  entityId: string,
  field: readonly string[],
  value: unknown,
): string {
  /*
   * Entity metadata is refused here, at the boundary, because the patcher does not refuse it: ask
   * it to set `id` and it writes a child `<id value="…"/>` next to the real fields — a silent wrong
   * write, which is worse than an error. Renaming an entity is `edit.content`, and it is a different
   * operation because every reference has to move with the name.
   */
  if (field.length === 1 && ['id', 'parent', 'default'].includes(field[0]!)) {
    throw new TypeError(`"${field[0]!}" is entity metadata, not a field: use edit.content to rename or reparent`)
  }
  const patched = patchCatalogField(
    xml,
    entityClass,
    entityId,
    field.join('.'),
    value === null ? null : String(value ?? ''),
  )
  if (!patched.changed) throw new TypeError(patched.reason ?? 'the catalog field was not changed')
  return patched.text
}
