/**
 * One entity written out as the game sees it: own fields and inherited ones together.
 *
 * A catalog file only ever states the difference from a parent, so reading it answers "what did
 * this mod change", never "what is this unit". MK2 opened the merged declaration beside the source
 * as a read-only document and that is the question a modder actually arrives with.
 *
 * Rendering is deliberately literal: the resolved value of a field, in declaration order, with no
 * schema opinion about which fields matter. A value the resolver reports as indexed keeps its
 * index, because an indexed slot and a scalar of the same name are different data.
 */

import type { RawFields } from '../../../shared/catalog-engine/xml/index.js'
import { entityToXml } from '../../../shared/format/entity-xml.js'

// Entity ids are data, including when embedded in an XML comment.
const comment = (value: string): string => value.replace(/--/gu, '—')

interface ResolvedEntityView {
  readonly namespace: string
  readonly id: string
  readonly fields: RawFields
  readonly chain: readonly string[]
  readonly partial: boolean
}

/** The merged declaration, as text, with a header saying what it is and what it is not. */
export function resolvedEntityViewXml(
  typeId: string,
  resolved: ResolvedEntityView,
  parent?: string,
): string {
  // The resolver reports the root of a chain as an empty id; it is the game's implicit default.
  const chain =
    resolved.chain.length === 0
      ? resolved.id
      : resolved.chain.map(link => (link === '' ? '(default)' : link)).join(' → ')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- Modkit: resolved view (own + inherited) of ${comment(`${resolved.namespace}/${resolved.id}`)} — read-only -->`,
    '<!-- Scope: loaded catalog only; workspace dependencies are not resolved by this operation. -->',
    `<!-- Parent chain: ${comment(chain)}${resolved.partial ? ' — partial: missing or cyclic parent' : ''} -->`,
    '<Catalog>',
    entityToXml(typeId, resolved.id, parent, resolved.fields, resolved.id === '', {
      indent: '  ',
      writeDefaultAttr: true,
    }),
    '</Catalog>',
    '',
  ].join('\n')
}
