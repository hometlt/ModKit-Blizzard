/**
 * The object editor's change files, one reading for the codec and the resolved data: which kind a
 * file changes, which layout its tables have, and how a change's value is written. Versions 1/2
 * and version 3 are read; the v3 opaque integer header is preserved separately from the single
 * modification list. Unknown-header semantics are not inferred by the resolved-data consumer.
 */
import BinaryStream from '../lib/mdx-m3-viewer/common/binarystream.js'
import War3MapW3d from '../lib/mdx-m3-viewer/parsers/w3x/w3d/file.js'
import War3MapW3u from '../lib/mdx-m3-viewer/parsers/w3x/w3u/file.js'
import type Modification from '../lib/mdx-m3-viewer/parsers/w3x/w3u/modification.js'
import type ModificationTable from '../lib/mdx-m3-viewer/parsers/w3x/w3u/modificationtable.js'

/** By file extension: what it changes and its distinct object-data namespace. */
export const OBJECT_MOD_KINDS: Readonly<Record<string, { readonly label: string; readonly levels: boolean; readonly namespace: string }>> = {
  w3u: { label: 'units', levels: false, namespace: 'unit' },
  w3t: { label: 'items', levels: false, namespace: 'item' },
  w3b: { label: 'destructables', levels: false, namespace: 'destructable' },
  w3h: { label: 'buffs', levels: false, namespace: 'buff' },
  w3d: { label: 'doodads', levels: true, namespace: 'doodad' },
  w3a: { label: 'abilities', levels: true, namespace: 'ability' },
  w3q: { label: 'upgrades', levels: true, namespace: 'upgrade' },
}

export const extensionOf = (path: string) => /\.([a-z0-9]+)(?:[?#].*)?$/iu.exec(path)?.[1]?.toLowerCase() ?? ''

export interface ObjectMods {
  readonly version: number
  /** Whether the changes carry a level (or variation) and a data column. */
  readonly levels: boolean
  readonly original: ModificationTable
  readonly custom: ModificationTable
}

/**
 * A change file's two tables. Doodad files of format 1 (every one in the 1.24 campaign maps) carry
 * no variation and data columns, ability and upgrade files do; later doodad files follow the
 * parser's layout. Bytes left over after the tables mean a wrong reading and are refused.
 */
export function readObjectMods(bytes: Uint8Array, extension: string): ObjectMods {
  const kind = OBJECT_MOD_KINDS[extension]
  if (kind === undefined) throw new TypeError(`«.${extension}» is not a Warcraft III object-editor file`)
  if (bytes.byteLength < 4) throw new TypeError('object-editor file is shorter than its version')
  const version = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true)
  if (version < 1 || version > 3) throw new TypeError(`object-editor format version ${String(version)} is not known`)
  const levels = kind.levels && !(extension === 'w3d' && version === 1)
  const file = levels ? new War3MapW3d() : new War3MapW3u()
  const stream = new BinaryStream(bytes)
  file.load(stream)
  if (stream.remaining !== 0) throw new TypeError(`${String(stream.remaining)} bytes after the object-editor tables`)
  return { version, levels, original: file.originalTable, custom: file.customTable }
}

/** An id as the game writes it: four characters, none when all four are NUL. */
export const objectId = (value: string) => (value === '\0\0\0\0' ? '' : value)

/** A change's value as the tables write it; a real at the shortest spelling that reads back the same. */
export function modValue(change: Modification): string {
  const value = change.value
  if (typeof value === 'string' || change.variableType === 0) return String(value)
  for (let digits = 1; digits <= 9; digits += 1) {
    const spelled = Number(value.toPrecision(digits))
    if (Math.fround(spelled) === value) return String(spelled)
  }
  return String(value)
}

export const MOD_TYPES = ['int', 'real', 'unreal', 'string']
