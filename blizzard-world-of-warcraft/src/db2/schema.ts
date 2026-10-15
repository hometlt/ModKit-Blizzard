/**
 * WoW DBD schema grammar and selection (GAME-WOW). This is an original format reader, not a
 * bundled WoWDBDefs dataset. Callers supply pinned definition text and its provenance separately.
 * A layout is selected by the file's hash AND the selected build; positions are never guessed.
 */
export interface DbdColumn {
  readonly name: string
  readonly type: 'int' | 'float' | 'string' | 'locstring'
  readonly unknown: boolean
  readonly reference?: { readonly table: string; readonly field: string }
}
export interface DbdField extends DbdColumn {
  readonly bits?: number
  readonly unsigned: boolean
  readonly count: number
  readonly id: boolean
  readonly relation: boolean
  readonly inline: boolean
}
export interface DbdLayout {
  readonly hashes: readonly string[]
  readonly builds: readonly string[]
  readonly fields: readonly DbdField[]
}
export interface DbdDefinition {
  readonly columns: ReadonlyMap<string, DbdColumn>
  readonly layouts: readonly DbdLayout[]
}

/** Parse only the documented column/layout grammar; unsupported tokens refuse explicitly. */
export function parseDbd(text: string, maxFields = 4096, maxLayouts = 4096): DbdDefinition {
  const columns = new Map<string, DbdColumn>()
  const layouts: DbdLayout[] = []
  let columnSection = false
  let hashes: string[] = []
  let builds: string[] = []
  let fields: DbdField[] = []
  const finish = (): void => {
    if (fields.length === 0) return
    if (hashes.length === 0 && builds.length === 0) throw new TypeError('DBD layout has neither BUILD nor LAYOUT')
    if (layouts.length >= maxLayouts) throw new RangeError('DBD layout budget exceeded')
    if (fields.filter(field => field.id).length > 1) throw new TypeError('DBD layout names multiple ID fields')
    layouts.push({ hashes, builds, fields })
    hashes = []; builds = []; fields = []
  }
  for (const [lineIndex, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.split('//', 1)[0]!.trim()
    if (line === '') { finish(); continue }
    if (line === 'COLUMNS') { columnSection = true; continue }
    if (/^(BUILD|LAYOUT) /u.test(line)) {
      if (fields.length > 0) finish()
      columnSection = false
      const [kind, ...rest] = line.split(/\s+/u)
      const values = rest.join('').split(',')
      if (kind === 'LAYOUT') {
        for (const hash of values) {
          if (!/^[\dA-Fa-f]{8}$/u.test(hash)) throw new TypeError(`DBD invalid layout hash at line ${String(lineIndex + 1)}`)
          hashes.push(hash.toUpperCase())
        }
      } else {
        for (const build of values) { buildRange(build); builds.push(build) }
      }
      continue
    }
    if (columnSection) {
      const match = /^(int|float|string|locstring)(?:<([\w]+)::([\w]+)>)?\s+(\w+)(\?)?$/u.exec(line)
      if (match === null) throw new TypeError(`DBD invalid column at line ${String(lineIndex + 1)}`)
      const name = match[4]!
      if (columns.has(name)) throw new TypeError(`DBD duplicate column ${name}`)
      if (columns.size >= maxFields) throw new RangeError('DBD column budget exceeded')
      columns.set(name, { name, type: match[1] as DbdColumn['type'], unknown: match[5] !== undefined,
        ...(match[2] === undefined ? {} : { reference: { table: match[2], field: match[3]! } }) })
      continue
    }
    const match = /^(?:\$([\w,]+)\$)?(\w+)(?:<(u?)(\d+)>)?(?:\[(\d+)\])?$/u.exec(line)
    if (match === null) throw new TypeError(`DBD invalid field at line ${String(lineIndex + 1)}`)
    const column = columns.get(match[2]!)
    if (column === undefined) throw new TypeError(`DBD undefined column ${match[2]!}`)
    if (fields.some(field => field.name === column.name)) throw new TypeError(`DBD duplicate field ${column.name}`)
    if (fields.length >= maxFields) throw new RangeError('DBD field budget exceeded')
    const flags = match[1]?.split(',') ?? []
    if (flags.some(flag => !['id', 'noninline', 'relation'].includes(flag))) throw new TypeError('DBD unsupported field annotation')
    const bits = match[4] === undefined ? undefined : Number(match[4])
    const count = match[5] === undefined ? 1 : Number(match[5])
    if (bits !== undefined && (column.type !== 'int' || bits < 1 || bits > 64)) throw new TypeError('DBD invalid integer width')
    if (!Number.isSafeInteger(count) || count < 1 || count > maxFields) throw new RangeError('DBD array budget exceeded')
    fields.push({ ...column, ...(bits === undefined ? {} : { bits }), unsigned: match[3] === 'u',
      count, id: flags.includes('id'), relation: flags.includes('relation'), inline: !flags.includes('noninline') })
  }
  finish()
  return { columns, layouts }
}

function buildParts(build: string): number[] {
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(build)) throw new TypeError(`DBD invalid build ${build}`)
  const parts = build.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) throw new RangeError('DBD build component is too large')
  return parts
}
function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!
  return 0
}
function buildRange(range: string): readonly [number[], number[]] {
  const parts = range.split('-')
  if (parts.length > 2) throw new TypeError('DBD invalid build range')
  const start = buildParts(parts[0]!)
  const end = buildParts(parts[1] ?? parts[0]!)
  if (compare(start, end) > 0) throw new TypeError('DBD reversed build range')
  return [start, end]
}

/** No fallback to the newest layout: a mismatched build/hash cannot decode typed rows safely. */
export function selectDbdLayout(definition: DbdDefinition, layoutHash: number, build: string): DbdLayout {
  const hash = layoutHash.toString(16).padStart(8, '0').toUpperCase()
  const selectedBuild = buildParts(build)
  const matches = definition.layouts.filter(layout =>
    layout.hashes.includes(hash) &&
    (layout.builds.length === 0 || layout.builds.some(range => {
      const [start, end] = buildRange(range)
      return compare(selectedBuild, start) >= 0 && compare(selectedBuild, end) <= 0
    })))
  if (matches.length === 0) throw new TypeError(`DBD has no layout for ${hash} / ${build}`)
  const unique = new Map(matches.map(layout => [JSON.stringify(layout.fields), layout]))
  if (unique.size !== 1) throw new TypeError(`DBD ambiguous layout for ${hash} / ${build}`)
  const selected = [...unique.values()][0]!
  if (selected.fields.filter(field => field.id).length !== 1) throw new TypeError('Selected DBD layout must name exactly one ID field')
  return selected
}
