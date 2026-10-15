#!/usr/bin/env node
/**
 * MK2 → MK3 operation parity, checked rather than asserted.
 *
 * "Is the port complete?" has been answered by reading two files side by side, every time it was
 * asked. That answer is only as good as the reading, and a renamed operation on either side turns a
 * true answer into a false one silently. This gate does the reading.
 *
 * The MK2 side is the ported `describe.ts` named by `mk2Source`, or the historical
 * `src/lib/mk2/codecs/<codec>/src/describe.ts` default. The operation tables it declares remain
 * MK2's own even when a domain restructure moves the preserved adapter.
 * The MK3 side is the codec contribution. Between them sits `expected-operation-parity.json`, an
 * explicit correspondence: MK2 named operations `patchValue` and `exportRaw` where MK3 names them
 * `edit.content` and `export.raw`, and no heuristic should be trusted to guess that.
 *
 * It fails on three things, and each is a real defect rather than a formatting difference:
 *   - an MK2 operation that was `available` and has neither a mapping nor a recorded reason;
 *   - a mapping that points at an MK3 operation id the contribution no longer declares;
 *   - a recorded absence for an operation MK3 has since implemented, which is stale bookkeeping.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectations = JSON.parse(
  readFileSync(join(root, 'scripts', 'expected-operation-parity.json'), 'utf8'),
)

/** The bracketed block that starts at `start`, balanced. */
function bracketBlock(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1
    else if (text[i] === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

/** Object literals sitting directly in the array, ignoring the ones nested inside them. */
function topLevelObjects(block) {
  const found = []
  let depth = 0
  let start
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (block[i] === '}') {
      depth -= 1
      if (depth === 0 && start !== undefined) {
        found.push(block.slice(start, i + 1))
        start = undefined
      }
    }
  }
  return found
}

/**
 * MK2's operation table for one codec.
 *
 * The table is the exported `*_OPERATIONS` constant, and only that: `describe.ts` also declares a
 * traits table whose entries have `id` fields too, and counting those was the first thing this
 * measurement got wrong.
 */
function mk2Operations(codec, expected) {
  if (expected.legacySnapshot !== undefined) {
    const snapshot = expected.legacySnapshot
    const rows = Array.isArray(snapshot.operations) ? snapshot.operations : []
    const operations = new Map()
    for (const row of rows) {
      if (
        row === null ||
        typeof row !== 'object' ||
        typeof row.name !== 'string' ||
        typeof row.state !== 'string'
      ) {
        return { relativePath: `frozen snapshot for ${codec}`, operations: undefined }
      }
      operations.set(row.name, row.state)
    }
    return { relativePath: `frozen snapshot for ${codec}`, operations }
  }
  const relativePath = expected.mk2Source ?? join('src', 'lib', 'mk2', 'codecs', codec, 'src', 'describe.ts')
  const path = join(root, 'starcraft2', relativePath)
  if (!existsSync(path)) return { relativePath, operations: undefined }
  const text = readFileSync(path, 'utf8')
  /*
   * Two shapes, because MK2 used two. Most codecs export a frozen `*_OPERATIONS` constant; the
   * strings codec builds its table in a `build*Operations` function, because two of its operations
   * change state depending on whether a resolver was injected. Both are the same array literal.
   */
  const table =
    /(?:export )?const [A-Z0-9_]*OPERATIONS[^=]*=\s*Object\.freeze\(\s*\[/.exec(text) ??
    /export function build[A-Za-z0-9]*Operations\([\s\S]*?return\s*(?:Object\.freeze\(\s*)?\[/.exec(text)
  if (table === null) return { relativePath, operations: undefined }
  const block = bracketBlock(text, text.indexOf('[', table.index + table[0].length - 1))
  const operations = new Map()
  for (const entry of topLevelObjects(block)) {
    const id = /^\s*id:\s*([^,\n]+),/m.exec(entry)
    if (id === null) continue
    const raw = id[1].trim()
    const literal = /^'([^']+)'$/.exec(raw)
    // `SAVE_OPERATION_IDS.sign` and `'sign'` name the same operation; the last segment is the name.
    const name = literal === null ? raw.split('.').at(-1).trim() : literal[1]
    const state = /^\s*state:\s*'([a-z-]+)'/m.exec(entry)
    operations.set(name, state === null ? 'available' : state[1])
  }
  return { relativePath, operations }
}

function mk3Operations(contribution) {
  const path = join(root, 'starcraft2', contribution.includes('/') ? contribution : join('contributions', contribution))
  if (!existsSync(path)) return undefined
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  return new Set((manifest.spec?.operations ?? []).map(item => item.id))
}

const problems = []
const rows = []

for (const [codec, expected] of Object.entries(expectations.codecs)) {
  const mk2Source = mk2Operations(codec, expected)
  const mk2 = mk2Source.operations
  const mk3 = mk3Operations(expected.contribution)
  if (mk2 === undefined) {
    problems.push(`${codec}: no MK2 operation table in starcraft2/${mk2Source.relativePath.replaceAll('\\', '/')}`)
    continue
  }
  if (mk3 === undefined) {
    problems.push(`${codec}: no contribution ${expected.contribution}`)
    continue
  }

  const mapping = expected.operations ?? {}
  let covered = 0
  let available = 0
  const missing = []

  for (const [name, state] of mk2) {
    const rule = mapping[name]
    if (state === 'available') available += 1
    if (rule === undefined) {
      if (state === 'available') missing.push(name)
      continue
    }
    if (typeof rule === 'string') {
      if (!mk3.has(rule)) {
        problems.push(`${codec}: ${name} is mapped to "${rule}", which the contribution does not declare`)
      } else if (state === 'available') covered += 1
      continue
    }
    // A recorded absence. It is stale the moment MK3 implements the operation.
    if (rule.mk3 !== undefined && mk3.has(rule.mk3)) {
      problems.push(`${codec}: ${name} is recorded absent but "${rule.mk3}" is now declared — remove the entry`)
    }
    if (rule.absent === undefined) {
      problems.push(`${codec}: ${name} has an entry with neither a target nor an "absent" reason`)
    }
  }

  for (const name of missing) {
    problems.push(`${codec}: MK2 offers "${name}" and nothing in expected-operation-parity.json accounts for it`)
  }

  const unmapped = [...mk2.keys()].filter(name => mapping[name] === undefined)
  rows.push({ codec, available, covered, mk3: mk3.size, unmapped: unmapped.length })
}

const width = Math.max(...rows.map(row => row.codec.length), 8)
console.log(`${'codec'.padEnd(width)}  MK2 available  covered  MK3 ops`)
for (const row of rows) {
  console.log(
    `${row.codec.padEnd(width)}  ${String(row.available).padStart(13)}  ${String(row.covered).padStart(7)}  ${String(row.mk3).padStart(7)}`,
  )
}

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\noperation parity: ${problems.length} unaccounted`)
  process.exitCode = 1
} else {
  const available = rows.reduce((sum, row) => sum + row.available, 0)
  const covered = rows.reduce((sum, row) => sum + row.covered, 0)
  console.log(`\noperation parity: ${covered} of ${available} MK2 operations accounted for`)
}
