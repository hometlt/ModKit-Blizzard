/**
 * Where an SC2Layout names a GameStrings key.
 *
 * A layout writes `@Key` (or `@@Key`, the racial variant) in a Text-typed value. Renaming a key in
 * a catalog has to rename these too, and the catalog provider cannot load the 1.5 MB layout schema
 * in a browser worker, so this scanner carries the forms instead. They are not a guess: the layout
 * schema types exactly these as `Text` across Blizzard's 377 core layouts, and
 * `modules/layout/test/layout-text-refs.test.ts` fails if the schema ever finds one this misses.
 * `Action type="SetProperty"` properties are added on top — the schema cannot type them, and core
 * layouts use `Text="@Key"` and `Tooltip="@Key"` there.
 */
import { scanXml, type ScannedElement } from '@modkit/codec-kit'

/** Elements whose `val` is Text-typed, and `<Key text>`. */
const TEXT_VALUE_ELEMENTS: ReadonlySet<string> = new Set([
  'Text',
  'Tooltip',
  'Replacement',
  'FormatText',
  'ReplacedName',
  'UpString',
])
const SET_PROPERTY_TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['text', 'tooltip'])

export interface LayoutTextReference {
  /** The GameStrings key, without its `@`/`@@` prefix. */
  readonly key: string
  /** Offsets of the bare key. */
  readonly start: number
  readonly end: number
}

function textAttributes(element: ScannedElement): readonly ScannedElement['attrs'][number][] {
  if (TEXT_VALUE_ELEMENTS.has(element.tag)) {
    return element.attrs.filter(attribute => attribute.name.toLowerCase() === 'val')
  }
  if (element.tag === 'Key') return element.attrs.filter(attribute => attribute.name.toLowerCase() === 'text')
  const type = element.attrs.find(attribute => attribute.name.toLowerCase() === 'type')?.value
  if (element.tag === 'Action' && type?.toLowerCase() === 'setproperty') {
    return element.attrs.filter(attribute => SET_PROPERTY_TEXT_ATTRIBUTES.has(attribute.name.toLowerCase()))
  }
  return []
}

export function layoutTextReferences(text: string): readonly LayoutTextReference[] {
  const found: LayoutTextReference[] = []
  const walk = (nodes: readonly ScannedElement[]): void => {
    for (const element of nodes) {
      for (const attribute of textAttributes(element)) {
        const prefix = /^@@?/u.exec(attribute.value)?.[0].length ?? 0
        if (prefix === 0) continue
        const key = attribute.value.slice(prefix)
        const start = attribute.valueStart + prefix
        if (key === '' || key.startsWith('@') || text.slice(start, start + key.length) !== key) continue
        found.push({ key, start, end: start + key.length })
      }
      walk(element.children)
    }
  }
  walk(scanXml(text))
  return found
}
