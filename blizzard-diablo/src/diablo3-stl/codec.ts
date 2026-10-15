/**
 * Diablo III StringList (`.stl`, SNO group 42): the game's text, one list per topic.
 *
 * Layout, measured on the installed game (2.8.0.99920, all 5,410 lists): the SNO preamble
 * (0xDEADBEEF, version 45, the list's own SNO id at 0x10), then at 0x28 the offset and size of the
 * entry array. Offsets count from 0x10, the start of the SNO data. An entry is 40 bytes: the
 * offset and size of its label, then of its text (each size includes the terminating NUL of a
 * UTF-8 string), then the djb2 hash of the label (h = h * 33 + byte, from zero, each byte taken
 * as a signed char: the credits' accented names hash that way). An empty list stores a zero offset
 * and size. The text keeps the game's markup verbatim (`<Title>`, `{s1}`, `[ms]…[fs]…` forms).
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { createInspectionCodec, createTableDataSource, createTreeDataSource } from '@modkit/codec-kit'

const ID = 'blizzard/diablo3-stl'
const MAGIC = 0xdeadbeef
const VERSION = 45
/** The SNO data, which every offset in the list counts from, starts past the preamble. */
const DATA = 0x10
const ENTRY_BYTES = 40

interface StringEntry {
  readonly label: string
  readonly text: string
  readonly hash: number
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The label hash the game stores beside every entry. */
function labelHash(bytes: Uint8Array): number {
  let hash = 0
  for (const byte of bytes) hash = (Math.imul(hash, 33) + ((byte << 24) >> 24)) >>> 0
  return hash
}

function parseStringList(bytes: Uint8Array, context: InspectionContext) {
  if (bytes.byteLength < 0x38) throw new RangeError('Diablo III StringList header is truncated')
  const view = viewOf(bytes)
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION)
    throw new TypeError('Diablo III StringList header is invalid or unsupported')
  const table = view.getUint32(0x28, true) + DATA
  const tableBytes = view.getUint32(0x2c, true)
  if (tableBytes % ENTRY_BYTES !== 0 || table + tableBytes > bytes.byteLength)
    throw new RangeError('Diablo III StringList entry array is out of bounds')
  const count = tableBytes / ENTRY_BYTES
  if (count > context.budget.maxNodes)
    throw new RangeError('Diablo III StringList entries exceed maxNodes budget')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const string = (at: number, what: string) => {
    const start = view.getUint32(at, true) + DATA
    const size = view.getUint32(at + 4, true)
    if (size === 0 || start + size > bytes.byteLength || bytes[start + size - 1] !== 0)
      throw new RangeError(`Diablo III StringList ${what} at ${at} is not a terminated string inside the file`)
    return bytes.subarray(start, start + size - 1)
  }
  const entries: StringEntry[] = []
  let mismatched = 0
  for (let index = 0; index < count; index += 1) {
    context.signal?.throwIfAborted()
    const at = table + index * ENTRY_BYTES
    const label = string(at + 8, 'label')
    const hash = view.getUint32(at + 32, true)
    if (labelHash(label) !== hash) mismatched += 1
    entries.push({ label: decoder.decode(label), text: decoder.decode(string(at + 24, 'text')), hash })
  }
  return { snoId: view.getInt32(0x10, true), entries, mismatched }
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'diablo3-stl', label: 'Diablo III StringList' }),
  async detect(prefix: Uint8Array, uri?: string) {
    if (prefix.byteLength < 0x48) return { confidence: 0, kind: 'magic', note: 'header-truncated' }
    const view = viewOf(prefix)
    const tableBytes = view.getUint32(0x2c, true)
    // other SNO groups share the magic and version 45; a list's first label starts right after its
    // entry array, and an empty list (zero offset and size) is only taken from a .stl file
    const list =
      view.getUint32(0, true) === MAGIC &&
      view.getUint32(4, true) === VERSION &&
      tableBytes % ENTRY_BYTES === 0 &&
      (tableBytes === 0
        ? view.getUint32(0x28, true) === 0 && /\.stl(?:$|[?#])/iu.test(uri ?? '')
        : view.getUint32(0x28, true) === 0x28 && view.getUint32(0x40, true) === 0x28 + tableBytes)
    return list
      ? { confidence: 0.99, kind: 'magic', note: 'deadbeef-v45-stringlist' }
      : { confidence: 0, kind: 'magic', note: 'signature-mismatch' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const list = parseStringList(bytes, context)
    const text = list.entries.map(entry => `${entry.label}\t${entry.text}`).join('\n')
    return {
      summary: {
        format: 'diablo3-stl',
        version: VERSION,
        snoId: list.snoId,
        entries: list.entries.length,
        hashMismatches: list.mismatched,
      },
      metadata: [
        {
          id: 'diablo3-stl',
          label: 'Diablo III StringList',
          entries: [
            { key: 'version', value: VERSION },
            { key: 'snoId', value: list.snoId },
            { key: 'entries', value: list.entries.length },
          ],
        },
      ],
      traits: [
        { id: 'content.text', parameters: { encoding: 'utf-8' } },
        { id: 'game.localization', parameters: { entries: list.entries.length } },
      ],
      diagnostics:
        list.mismatched === 0
          ? []
          : [
              {
                id: 'blizzard.diablo3-stl/label-hash-mismatch',
                severity: 'warning' as const,
                category: 'structure' as const,
                code: 'blizzard.diablo3-stl/label-hash-mismatch',
                message: `${list.mismatched} entries store a hash that is not the djb2 hash of their label`,
              },
            ],
      text,
      maxDecodedBytes: Math.max(bytes.byteLength, new TextEncoder().encode(text).byteLength),
      dataSources: {
        'common.view/table-data-source': createTableDataSource({
          header: ['Label', 'Text', 'Hash'],
          rows: list.entries.map(entry => [entry.label, entry.text, entry.hash.toString(16).padStart(8, '0')]),
        }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'catalog',
          label: 'Diablo III StringList',
          preview: `${list.entries.length} strings`,
          children: list.entries.map(entry => ({
            kind: 'string',
            label: entry.label,
            preview: entry.text.slice(0, 120),
          })),
        }),
      },
      unsupportedFeatures: ['stringlist-writing', 'locale-merge'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
