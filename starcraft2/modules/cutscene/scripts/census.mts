#!/usr/bin/env node
/**
 * The census: every number the cutscene specification claims, recomputed from the corpus.
 *
 * The specification in `reports/SPEC_PLAN_sc2cutscene_2026-09-08.md` is measurement, not
 * documentation — there is no published documentation for this format. A measurement nobody can
 * repeat is a claim, so this is the script that repeats it, and the corpus test asserts a handful
 * of its answers so a drifting reader is caught rather than a drifting document.
 *
 * It also runs the byte-identical round trip over every file, because "the reader kept everything"
 * has no other honest test.
 *
 *   node --import tsx modules/cutscene/scripts/census.mts <corpus-root> [--json]
 *
 * With no root it uses `references/SC2GameData` beside the coding workspace, which is where the
 * extracted campaign and mod data lives.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeCutscene, CutsceneParseError } from '../codecs/cutscene/src/decode.js'
import { encodeCutscene } from '../codecs/cutscene/src/encode.js'
import { pathTangentsOf } from '../codecs/cutscene/src/curves.js'
import { externalReferencesOf } from '../codecs/cutscene/src/refs.js'
import { isKnownTag } from '../codecs/cutscene/src/registry.js'
import { validateCutscene } from '../codecs/cutscene/src/validate.js'
import { walk } from '../codecs/cutscene/src/model.js'

const CUTSCENE_FILE = /\.(sc2cutscene|stormcutscene)$/iu

function cutsceneFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) cutsceneFiles(path, found)
    else if (CUTSCENE_FILE.test(entry.name)) found.push(path)
  }
  return found
}

export interface CutsceneCensus {
  files: number
  bytes: number
  parsed: number
  roundTripped: number
  failures: { path: string; reason: string }[]
  versions: Record<string, number>
  tags: Record<string, number>
  unknownTags: Record<string, number>
  maxDepth: number
  byteOrderMarks: number
  declarations: Record<string, number>
  /** Identifiers, and how many of them no 64-bit integer can hold. */
  guids: { total: number; widerThanUint64: number; longest: string }
  duplicateGuidFiles: number
  duplicateGuids: number
  danglingReferences: Record<string, number>
  referenceTotals: Record<string, number>
  externalReferences: Record<string, number>
  curveKeys: number
  curveInTypes: Record<string, number>
  /**
   * The same attribute where it is not on a curve key. 58 path markers carry it directly, and every
   * occurrence of type `2` in the corpus is one of them — counting only curve keys reports six of
   * the format's seven tangent types.
   */
  pathMarkerInTypes: Record<string, number>
}

export function census(paths: readonly string[]): CutsceneCensus {
  const result: CutsceneCensus = {
    files: paths.length,
    bytes: 0,
    parsed: 0,
    roundTripped: 0,
    failures: [],
    versions: {},
    tags: {},
    unknownTags: {},
    maxDepth: 0,
    byteOrderMarks: 0,
    declarations: {},
    guids: { total: 0, widerThanUint64: 0, longest: '' },
    duplicateGuidFiles: 0,
    duplicateGuids: 0,
    danglingReferences: {},
    referenceTotals: {},
    externalReferences: {},
    curveKeys: 0,
    curveInTypes: {},
    pathMarkerInTypes: {},
  }
  const uint64Max = 18446744073709551615n
  const bump = (bucket: Record<string, number>, key: string, by = 1): void => {
    bucket[key] = (bucket[key] ?? 0) + by
  }

  for (const path of paths) {
    const bytes = readFileSync(path)
    result.bytes += bytes.byteLength
    let document
    try {
      document = decodeCutscene(bytes)
    } catch (error) {
      const reason =
        error instanceof CutsceneParseError ? error.message : String((error as Error).message)
      result.failures.push({ path, reason })
      continue
    }
    result.parsed += 1
    if (Buffer.from(encodeCutscene(document)).equals(bytes)) result.roundTripped += 1
    else result.failures.push({ path, reason: 'round trip is not byte-identical' })

    if (document.byteOrderMark) result.byteOrderMarks += 1
    bump(result.declarations, document.declaration)
    bump(result.versions, document.version ?? '(absent)')

    let depth = 0
    const stack: { element: (typeof document)['root']; level: number }[] = [
      { element: document.root, level: 1 },
    ]
    while (stack.length > 0) {
      const { element, level } = stack.pop() as { element: (typeof document)['root']; level: number }
      depth = Math.max(depth, level)
      for (const child of element.children) stack.push({ element: child, level: level + 1 })
    }
    result.maxDepth = Math.max(result.maxDepth, depth)

    for (const element of walk(document.root)) {
      bump(result.tags, element.tag)
      if (!isKnownTag(element.tag)) bump(result.unknownTags, element.tag)
      if (element.tag === 'CCutsceneElementPropertyCurve') {
        result.curveKeys += 1
        const type = element.attributes.find(item => item.name === 'curveInType')?.value
        if (type !== undefined) bump(result.curveInTypes, type)
      }
      for (const attribute of element.attributes) {
        if (!/guid$/iu.test(attribute.name) || !/^\d+$/u.test(attribute.value)) continue
        result.guids.total += 1
        if (BigInt(attribute.value) > uint64Max) result.guids.widerThanUint64 += 1
        if (attribute.value.length > result.guids.longest.length) {
          result.guids.longest = attribute.value
        }
      }
    }

    const report = validateCutscene(document)
    if (report.duplicateGuids.length > 0) {
      result.duplicateGuidFiles += 1
      result.duplicateGuids += report.duplicateGuids.reduce(
        (sum, item) => sum + item.occurrences - 1,
        0,
      )
    }
    for (const [attribute, total] of report.referenceTotals) bump(result.referenceTotals, attribute, total)
    for (const dangling of report.danglingReferences) bump(result.danglingReferences, dangling.attribute)
    for (const type of pathTangentsOf(document).typeIn) bump(result.pathMarkerInTypes, String(type))
    for (const reference of externalReferencesOf(document)) bump(result.externalReferences, reference.role)
  }
  return result
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const root =
    args.find(item => !item.startsWith('--')) ??
    resolve(fileURLToPath(new URL('../../../../../references/SC2GameData', import.meta.url)))
  const files = cutsceneFiles(root)
  const measured = census(files)
  if (asJson) {
    process.stdout.write(`${JSON.stringify(measured, null, 2)}\n`)
  } else {
    const { tags, unknownTags, failures, ...summary } = measured
    process.stdout.write(`corpus: ${root}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(
      `tags: ${Object.entries(tags)
        .sort((left, right) => right[1] - left[1])
        .map(([tag, count]) => `${tag}=${count}`)
        .join(' ')}\n`,
    )
    if (Object.keys(unknownTags).length > 0) {
      process.stdout.write(`unknown tags: ${JSON.stringify(unknownTags)}\n`)
    }
    for (const failure of failures.slice(0, 20)) {
      process.stdout.write(`FAIL ${failure.path}: ${failure.reason}\n`)
    }
  }
  process.exitCode = measured.failures.length === 0 ? 0 : 1
}
