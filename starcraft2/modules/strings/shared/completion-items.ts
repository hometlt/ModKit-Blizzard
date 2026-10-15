/**
 * A strings completion in the language contract's vocabulary.
 *
 * One mapping for the language provider and for the table's value editor, so a value typed in a
 * `.txt` editor and the same value typed in a table cell are offered the same items.
 */
import type { LanguageCompletionItem } from '@modkit/sdk'
import type { StringCompletion } from './core/complete.js'

const COMPLETION_KIND: Readonly<Record<StringCompletion['kind'], LanguageCompletionItem['kind']>> =
  Object.freeze({
    tag: 'keyword',
    attribute: 'property',
    namespace: 'namespace',
    entity: 'class',
    field: 'field',
    color: 'constant',
    style: 'type',
    // No `file` kind exists in the completion vocabulary; an asset alias names a thing, so it is a
    // constant rather than something invented.
    asset: 'constant',
    // The vocabulary has `enum` but no `enum-member`; an enumerated value is offered as its enum.
    enum: 'enum',
  })

// Snippet syntax owns `$`, `}` and `\`; an insertion holding one goes in as plain text, caret last.
const SNIPPET_SYNTAX = /[$}\\]/u

export function languageCompletionItem(item: StringCompletion): LanguageCompletionItem {
  const caret = item.caret
  // `<c val=""></c>` leaves the caret inside the tag, as MK2 did: a snippet with `$0` there.
  const snippet =
    caret !== undefined && caret < item.insert.length && !SNIPPET_SYNTAX.test(item.insert)
  return {
    label: item.label,
    kind: COMPLETION_KIND[item.kind] ?? 'text',
    ...(snippet
      ? {
          insertText: `${item.insert.slice(0, caret)}$0${item.insert.slice(caret)}`,
          insertTextFormat: 'snippet' as const,
        }
      : { insertText: item.insert }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.asset === undefined ? {} : { asset: { path: item.asset } }),
  }
}
