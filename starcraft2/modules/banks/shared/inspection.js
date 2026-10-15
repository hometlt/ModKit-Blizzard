// Preserved MK3 facts/relations projection. Canonical MK2 values are supplied by the native adapter.
// model.js remains the existing strict XML/budget guard and workspace/BankList compatibility surface.
import { createTreeDataSource } from '@modkit/codec-kit'
import {
  createTableDataSource,
  decodeStructuredText,
  lineCount,
} from '../../../shared/inspection/structured-text.js'
import { parseSc2Bank, coerceSc2BankValue } from './model.js'
import { createBankSources } from './sources.js'

function sourceLabel(uri) {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  try {
    return decodeURIComponent(normalized.split('/').at(-1) || 'StarCraft II bank')
  } catch {
    return normalized.split('/').at(-1) || 'StarCraft II bank'
  }
}

/**
 * Publish a bank value as a typed, editable field.
 *
 * The six bank types are the ones MK2's validator accepted, and each maps to the control that can
 * actually express it: `int` and `fixed` to a number (integer or not), `flag` to a checkbox,
 * everything else to text. `point` stays text on purpose — it is two numbers in one attribute, and
 * a vector control would have to invent a separator the format does not promise.
 *
 * A key with no `<Value>` element publishes nothing: there is no value to type and none to write.
 */
function bankFieldFacts(value, shape = 'node') {
  if (value === undefined) return undefined
  const type =
    value.type === 'int'
      ? { kind: 'number', integer: true }
      : value.type === 'fixed'
        ? { kind: 'number' }
        : value.type === 'flag'
          ? { kind: 'boolean' }
          : { kind: 'text' }
  const semantic = value.semantic
  const typed = semantic === undefined ? value.value : semantic
  return {
    // `TreeNodeFacts` names it `value`; `CellFacts` already spends that name on display text and
    // names the typed one `typedValue`. Same fact, two contracts.
    ...(shape === 'cell' ? { typedValue: typed } : { value: typed }),
    type,
    unit: value.type,
    editable: { write: { operation: 'edit.field' }, editor: 'scalar' },
  }
}

export const definition = Object.freeze({
  async inspect(bytes, context, parsedBank) {
    const text = decodeStructuredText(bytes, context.budget, 'SC2 bank')
    const mature = parseSc2Bank(text, context.budget)
    const bank =
      parsedBank === undefined
        ? mature
        : {
            ...mature,
            version: parsedBank.version ?? mature.version,
            signature: parsedBank.signature ?? '',
            sections: parsedBank.sections.map(section => ({
              ...section,
              keys: section.keys.map(key => ({
                ...key,
                ...(key.value === undefined
                  ? {}
                  : {
                      value: {
                        ...key.value,
                        semantic: coerceSc2BankValue(key.value),
                      },
                    }),
              })),
            })),
          }
    const keys = bank.sections.flatMap(section => section.keys)
    const flatKeys = bank.sections.flatMap(section =>
      section.keys.map(key => ({ section: section.name, key: key.name, value: key.value })),
    )
    const valueTypes = [
      ...new Set(keys.flatMap(key => (key.value === undefined ? [] : [key.value.type]))),
    ].sort()
    const source = context.primary.source
    const semanticSources = createBankSources(bank, {
      snapshotId: String(context.input.revisions.revision),
      subjectId: source.id,
      label: sourceLabel(source.uri),
      source,
    })
    return {
      summary: {
        format: 'sc2-bank',
        version: bank.version,
        lines: lineCount(text),
        sections: bank.sections.length,
        keys: keys.length,
        valueTypes,
        signaturePresent: bank.signature !== '',
      },
      metadata: [
        {
          id: 'sc2-bank',
          label: 'SC2 bank',
          entries: [
            /*
             * Counts, not values. Nothing here is editable and none of it claims to be: the number
             * of sections is an observation about the file, and a control offering to change it
             * would be offering something no writer can carry out.
             */
            { key: 'version', value: bank.version },
            { key: 'sections', value: bank.sections.length },
            { key: 'keys', value: keys.length },
            { key: 'signaturePresent', value: bank.signature !== '' },
            { key: 'elements', value: bank.elementCount },
          ],
        },
        /*
         * The stored values, as an editable properties group.
         *
         * This is the same data the tree carries, published for the surface a reader reaches for
         * when they want the file's properties rather than its structure. The key is
         * `Section/Key`, which is what `edit.field` resolves the write by, so a properties edit and
         * a tree edit land on the same patch.
         */
        ...(flatKeys.length === 0
          ? []
          : [
              {
                id: 'values',
                label: 'Bank values',
                entries: flatKeys.flatMap(entry => {
                  const facts = bankFieldFacts(entry.value)
                  if (facts === undefined) return []
                  return [{ key: `${entry.section}/${entry.key}`, ...facts }]
                }),
              },
            ]),
      ],
      traits: [
        { id: 'content.text', parameters: { language: 'xml', lines: lineCount(text) } },
        {
          id: 'structure.hierarchy',
          parameters: { sections: bank.sections.length, keys: keys.length },
        },
        {
          id: 'content.metadata',
          parameters: { version: bank.version, signature: bank.signature !== '' },
        },
      ],
      text: true,
      dataSources: {
        'common.view/table-data-source': createTableDataSource(
          ['Section', 'Key', 'Type', 'Value'],
          flatKeys.map(entry => [
            entry.section,
            entry.key,
            entry.value?.type ?? '',
            entry.value?.value ?? '',
          ]),
          // Only the Value column is a value; Section, Key and Type describe where it lives, and
          // rewriting those means restructuring the bank rather than editing a field.
          (row, column) =>
            column === 3 ? bankFieldFacts(flatKeys[row]?.value, 'cell') : undefined,
        ),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'bank',
          label: 'StarCraft II bank',
          preview: `${bank.sections.length} section(s), ${keys.length} key(s)`,
          children: bank.sections.map(section => ({
            kind: 'section',
            label: section.name,
            preview: `${section.keys.length} key(s)`,
            children: section.keys.map(key => ({
              kind: 'key',
              label: key.name,
              preview:
                key.value === undefined ? undefined : `${key.value.type}: ${key.value.value}`,
              // The semantic path is what `edit.field` resolves a write by, so it names the
              // section and the key rather than their positions: an edit elsewhere in the file
              // must not silently retarget this one.
              semanticPath: [section.name, key.name],
              ...(bankFieldFacts(key.value) ?? {}),
            })),
          })),
        }),
        'common.view/subject-facts-source': semanticSources.factsSource,
        'common.view/relation-graph-source': semanticSources.relationGraphSource,
      },
    }
  },
})
