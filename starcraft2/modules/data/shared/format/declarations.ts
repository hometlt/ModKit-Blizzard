/**
 * Where a catalog document declares its entities: the span of each entity's opening tag, so a card
 * fact or a resource opens the declaration (parity plan 5.2). Text coordinates are zero-based UTF-16
 * code units, line and column, as `SourceSpan` spells them.
 */
import { catalogEntities } from './language/entity.js'
import { getAttr, scanXml } from './language/xml-scan.js'

export interface DeclarationSpan {
  readonly utf16Offset: number
  readonly utf16Length: number
  readonly line: number
  readonly column: number
}

/** Each entity id's first declaration in the document (a later patch of the same id is a patch). */
export function entityDeclarationSpans(text: string): ReadonlyMap<string, DeclarationSpan> {
  const spans = new Map<string, DeclarationSpan>()
  let line = 0
  let lineStart = 0
  let scanned = 0
  for (const element of catalogEntities(scanXml(text))) {
    const id = getAttr(element, 'id')?.value
    if (id === undefined || spans.has(id)) continue
    // Entities come in document order, so the line count only moves forward.
    for (; scanned < element.start; scanned += 1) {
      if (text.charCodeAt(scanned) === 10) {
        line += 1
        lineStart = scanned + 1
      }
    }
    spans.set(
      id,
      Object.freeze({
        utf16Offset: element.start,
        utf16Length: element.openEnd - element.start,
        line,
        column: element.start - lineStart,
      }),
    )
  }
  return spans
}
