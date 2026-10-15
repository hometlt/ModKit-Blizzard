/**
 * Generates src/diablo3-sno/field-names.ts: readable names for members of the SNO structures, taken
 * from WhiteoutLib's Diablo III definitions (references/WhiteoutLib, BSD-3-Clause, © 2026 Fernando
 * Sahmkow) and kept only where they fit the registry the installed game's executable describes.
 *
 * WhiteoutLib lists each type's fields flat, by offset from the structure's start, with its own
 * reading of their meaning. The registry is exact but nameless. A name is kept when the registry has
 * a leaf member of a compatible type at the same absolute offset (nested structures are walked, so a
 * name WhiteoutLib gives the first member of a nested vector lands on that member); a name for an
 * array is kept when the registry has an array there. Names starting `unk` or `_` say nothing and are
 * dropped. Element types of arrays are matched through the arrays that hold them.
 *
 * Usage: node scripts/generate-sno-field-names.mjs  (needs the Diablo III installation discovery finds)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createNodeInstallationFiles } from '@modkit/host/node'

const root = join(import.meta.dirname, '..')
const source = join(root, '..', '..', 'references', 'WhiteoutLib', 'src', 'whiteout', 'sno', 'd3', 'sno_defs.cpp')
const text = readFileSync(source, 'utf8')
const { discoverDiablo3Installations } = await import(new URL('../dist/game/installation.js', import.meta.url).href)
const { createProvider } = await import(new URL('../dist/diablo3-sno/provider.js', import.meta.url).href)

// ── WhiteoutLib tables ───────────────────────────────────────────────────────────────────────────
const block = name => {
  const start = text.indexOf(`${name}[`)
  const open = text.indexOf('{', start)
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1
    else if (text[at] === '}' && --depth === 0) return text.slice(open + 1, at)
  }
  throw new Error(`no table ${name}`)
}
const strings = body => [...body.replace(/\/\/[^\n]*/gu, '').matchAll(/"([^"]*)"/gu)].map(match => match[1])
const fieldNames = strings(block('kFieldNames'))
const typeNames = strings(block('kTypeNames')).map(name => name.replace(/^D3::/u, ''))
const types = [...block('kTypes').replace(/\/\/[^\n]*/gu, '').matchAll(/\{(\d+)u,\s*(\d+)u,\s*(\d+)u,\s*(\d+)u,\s*(\d+)u,\s*(\d+)u,\s*(\d+)u\}/gu)].map(
  (match, index) => ({ name: typeNames[index], hash: Number(match[1]), size: Number(match[3]), first: Number(match[5]), count: Number(match[6]) }),
)
// a field entry, then its comment (which names its type): `{{h, h, h}, name, flags, offset, …}, // name (DT_X, …)`
const fields = []
const fieldBody = block('kFields')
const entry = /\{\{(\d+)u,\s*(\d+)u,\s*(\d+)u\},\s*(\d+)u,\s*(\d+)u,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\},?((?:\s*\/\/[^\n]*)*)/gu
for (const match of fieldBody.matchAll(entry)) {
  const comment = match[10].replace(/\s*\/\/\s*/gu, ' ')
  fields.push({ hashes: [Number(match[1]), Number(match[2]), Number(match[3])], name: fieldNames[Number(match[4])], offset: Number(match[6]), type: /\((DT_[A-Z0-9_]+|[A-Za-z]+)/u.exec(comment)?.[1] })
}
// the basic type each hash stands for, learned from the entries whose comment names it
const typeOfHash = new Map()
for (const field of fields) if (field.type?.startsWith('DT_') && !typeOfHash.has(field.hashes[0])) typeOfHash.set(field.hashes[0], field.type)
const complexByHash = new Map(types.map(type => [type.hash, type]))

// ── the registry of the installed game ───────────────────────────────────────────────────────────
const installation = (await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 8 })).installations[0]
if (installation === undefined) throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')
const installationFiles = createNodeInstallationFiles({ installationOf: () => installation.normalizedPath })
const registry = await createProvider({ contract: 'blizzard/diablo3-sno-registry', major: 1 }, { installationFiles }).value.registry({})
const nameOf = id => registry.structures[id]?.name ?? registry.basics[id] ?? id
const structuresNamed = name => Object.values(registry.structures).filter(structure => structure.name.toLowerCase() === name.toLowerCase())

/**
 * Leaves (basic members and arrays) of a registry structure by absolute offset, nested structures
 * walked — except animated paths (FloatPath, ColorPath, …): a name falling inside a path's
 * interpolation header is a flat misreading of an animated value, not a field.
 */
function leaves(structure, base = 0, out = new Map()) {
  for (const field of structure.fields) {
    const type = nameOf(field.type)
    if (type === 'DT_NULL' || type === 'SerializeData') continue
    const nested = registry.structures[field.type]
    if (nested !== undefined && /Path$|PathHeader$/u.test(nested.name)) continue
    if (nested !== undefined) leaves(nested, base + field.offset, out)
    else if (!out.has(base + field.offset)) out.set(base + field.offset, { type, element: field.element === undefined ? undefined : field.element })
  }
  return out
}

const INTEGERS = new Set(['DT_INT', 'DT_ENUM', 'DT_FLAG', 'DT_WORD', 'DT_BYTE', 'DT_GBID', 'DT_SNO_GROUP', 'DT_SNONAME_HANDLE', 'DT_DATAID', 'DT_RGBACOLOR', 'DT_ATTRIBUTEPARAM', 'DT_TRANSLATEABLE'])
const FLOATS = new Set(['DT_FLOAT', 'DT_TIME', 'DT_ANGLE', 'DT_ACCEL', 'DT_ANGULARVELOCITY', 'DT_IMPULSE', 'DT_MASS', 'DT_VELOCITY', 'DT_PERCENT', 'DT_HIGHPRECISIONPERCENT'])
const ARRAYS = new Set(['DT_VARIABLEARRAY', 'DT_FIXEDARRAY', 'DT_CHARARRAY', 'DT_TAGMAP', 'DT_CSTRING', 'DT_FORMULA', 'DT_OPTIONAL'])
function compatible(theirs, ours) {
  if (theirs === undefined) return false
  if (theirs === ours) return true
  if (INTEGERS.has(theirs) && INTEGERS.has(ours)) return true
  if (FLOATS.has(theirs) && FLOATS.has(ours)) return true
  if (ARRAYS.has(theirs) && ARRAYS.has(ours)) return true
  return false
}
const telling = name => name !== undefined && !/^(unk|_|pad)|reserved|unknown|const[0-9a-f]{2,}|[0-9a-f]{3}$/iu.test(name)

const out = {}
let kept = 0
let dropped = 0
const matched = new Set()
const matchedTypes = new Set()
/** How many of a WhiteoutLib type's telling fields a registry structure has at the same offset with a compatible type. */
function fit(theirs, ours) {
  const ourLeaves = leaves(ours)
  return fields.slice(theirs.first, theirs.first + theirs.count).filter(field => {
    const leaf = ourLeaves.get(field.offset)
    const type = field.type?.startsWith('DT_') ? field.type : typeOfHash.get(field.hashes[0])
    return telling(field.name) && leaf !== undefined && compatible(type, leaf.type)
  }).length
}
function nameStructure(theirs, ours) {
  if (matched.has(`${theirs.name}>${ours.name}/${ours.size}`)) return
  matched.add(`${theirs.name}>${ours.name}/${ours.size}`)
  matchedTypes.add(theirs.name)
  const ourLeaves = leaves(ours)
  const names = {}
  for (const field of fields.slice(theirs.first, theirs.first + theirs.count)) {
    const type = field.type?.startsWith('DT_') ? field.type : typeOfHash.get(field.hashes[0])
    const leaf = ourLeaves.get(field.offset)
    if (!telling(field.name)) continue
    if (leaf === undefined || !compatible(type, leaf.type) || names[field.offset] !== undefined) {
      dropped += 1
      continue
    }
    names[field.offset] = field.name
    kept += 1
    // an array of a WhiteoutLib structure names the registry structure of its elements
    const element = complexByHash.get(field.hashes[1])
    const ourElement = leaf.element === undefined ? undefined : registry.structures[leaf.element]
    if (element !== undefined && ourElement !== undefined && element.count > 0) nameStructure(element, ourElement)
  }
  if (Object.keys(names).length > 0) out[`${ours.name}/${ours.size}`] = { ...(out[`${ours.name}/${ours.size}`] ?? {}), ...names }
}
// WhiteoutLib reads the 412-byte ANI entries as "looks"; the registry calls them KeyframedAttachment.
// Its particle layout (48-byte blocks from 0x68) runs across the registry's animated paths (0x30, 0x60, …)
const CONFLICTING = new Set(['AnimLookEntry', 'Particle'])
const ROOTS = { Appearances: 'Appearance' }
for (const type of types) {
  if (type.count === 0 || CONFLICTING.has(type.name)) continue
  const candidates = structuresNamed(ROOTS[type.name] ?? type.name)
  const ours = candidates.find(structure => structure.size === type.size) ?? candidates.sort((a, b) => b.size - a.size)[0]
  if (ours !== undefined) nameStructure(type, ours)
}
// the element types WhiteoutLib does not reach through an array: the structure of their size, reachable
// from a named root, that fits the most of their fields (Structure/400 and SubObject/400 share a size)
const reachable = new Map()
const reach = structure => {
  for (const field of structure.fields)
    for (const id of [field.type, field.element]) {
      const nested = id === undefined ? undefined : registry.structures[id]
      if (nested !== undefined && !reachable.has(nested.id)) {
        reachable.set(nested.id, nested)
        reach(nested)
      }
    }
}
for (const key of Object.keys(out)) {
  const [name, size] = key.split('/')
  const structure = structuresNamed(name).find(item => String(item.size) === size)
  if (structure !== undefined) reach(structure)
}
for (const type of types) {
  if (type.count === 0 || matchedTypes.has(type.name) || CONFLICTING.has(type.name)) continue
  const scored = [...reachable.values()]
    .filter(structure => structure.size === type.size)
    .map(structure => ({ structure, score: fit(type, structure) }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  const telling_ = fields.slice(type.first, type.first + type.count).filter(field => telling(field.name)).length
  if (best !== undefined && best.score > 0 && best.score * 2 >= telling_ && best.score > (scored[1]?.score ?? 0)) nameStructure(type, best.structure)
}

const digest = createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
const body = Object.entries(out)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, names]) => `  '${key}': { ${Object.entries(names).map(([offset, name]) => `${offset}: '${name}'`).join(', ')} },`)
  .join('\n')
writeFileSync(
  join(root, 'src', 'diablo3-sno', 'field-names.ts'),
  `/**
 * Readable names of SNO structure members, by structure (\`name/size\`) and absolute byte offset.
 *
 * Generated by scripts/generate-sno-field-names.mjs — do not edit. Names come from WhiteoutLib's
 * Diablo III definitions (${relative(root, source).replaceAll('\\', '/')}, sha256 ${digest};
 * BSD-3-Clause, Copyright (c) 2026 Fernando Sahmkow) and are kept only where the registry of the
 * installed game (${installation.version ?? 'unknown version'}) has a member of a compatible type at the same offset:
 * ${kept} kept, ${dropped} dropped.
 */
export const SNO_FIELD_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
${body}
}
`,
)
console.log(`kept ${kept}, dropped ${dropped}, structures ${Object.keys(out).length}: ${Object.keys(out).join(', ')}`)
