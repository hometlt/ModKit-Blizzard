import { subjectIdFor } from '@modkit/codec-kit'

/**
 * An entity id a rename may write: MK2's rule — a letter or `_`, then letters, digits, `_`, `@`
 * and `.` (plan 1.14). One rule for every SC2 language that renames a catalog entity.
 */
export const SC2_ENTITY_ID = /^[A-Za-z_][\w@.]*$/u

/** The scope of an SC2 catalog entity's subject id: the Data codec reopens it. */
export const SC2_ENTITY_SUBJECT_SCOPE = 'blizzard/sc2-data'

/**
 * The subject id an SC2 catalog entity's card, relation graph and resolved view open on
 * (`modkit-subject://blizzard%2Fsc2-data/Unit/Marine`): the id the Data codec publishes its cards
 * by and Resources lists the entity by. A language command naming it opens the card at once,
 * instead of an application searching the loaded mods for a `Unit/Marine` row.
 */
export function sc2EntitySubjectId(namespace: string, id: string): string {
  return subjectIdFor(SC2_ENTITY_SUBJECT_SCOPE, [namespace, id])
}
