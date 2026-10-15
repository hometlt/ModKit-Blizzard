/**
 * Node-only string helpers: git change-tracking and staging-folder collection.
 * Imported via `@modkitx/strings/node`. See docs/tasks-active/entity-cards-strings/PLAN-strings-cards-views.md (A8).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { diffStringTexts, stringsText, type StringChange } from './diff.js'

const run = promisify(execFile)

export type { StringChange }

async function gitShow(cwd: string, ref: string, relPath: string): Promise<string | undefined> {
  // `<rev>:./<path>` resolves the path relative to `cwd` (the -C dir), so this works
  // even when the mod is a subdirectory of a larger repo. Forward slashes always.
  const objectPath = './' + relPath.split(path.sep).join('/')
  try {
    const { stdout } = await run('git', ['-C', cwd, 'show', `${ref}:${objectPath}`], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return undefined // file did not exist at that ref
  }
}

export interface GitDiffStringsOptions {
  /** A directory inside the git repo (e.g. the mod root). */
  cwd: string
  /** Path to the locale `.txt`, relative to `cwd` (or absolute). */
  file: string
  /** Base ref to compare from (e.g. `HEAD~1`, a tag, a commit SHA). */
  fromRef: string
  /** Ref to compare to; omit to use the current working-tree file. */
  toRef?: string
}

/**
 * Key-level changes to a locale string file between two git refs (or `fromRef` →
 * working tree). Robust: reads both versions via `git show` and diffs by key.
 */
export async function gitDiffStrings(opts: GitDiffStringsOptions): Promise<StringChange[]> {
  const abs = path.isAbsolute(opts.file) ? opts.file : path.join(opts.cwd, opts.file)
  const rel = path.relative(opts.cwd, abs)
  const oldText = await gitShow(opts.cwd, opts.fromRef, rel) ?? ''
  const newText = opts.toRef
    ? (await gitShow(opts.cwd, opts.toRef, rel) ?? '')
    : await fs.readFile(abs, 'utf-8').catch(() => '')
  return diffStringTexts(oldText, newText)
}

export interface StageOptions {
  /** Entries to write (key + value). */
  entries: Array<{ key: string; value: string }>
  /** Destination `.txt` file (parent dirs are created). */
  outFile: string
}

/**
 * Write a subset of strings to a staging `.txt` file (SC2 `key=value` format), e.g.
 * the changed/missing keys to hand to a translator. Creates parent directories.
 */
export async function collectToStaging(opts: StageOptions): Promise<void> {
  await fs.mkdir(path.dirname(opts.outFile), { recursive: true })
  const body = stringsText(opts.entries)
  await fs.writeFile(opts.outFile, body, 'utf-8')
}

/**
 * Convenience: stage the changed keys (added/modified) from a git diff into a folder,
 * pulling the new value for each. Returns the staged file path.
 */
export async function stageChangedStrings(opts: GitDiffStringsOptions & { outDir: string }): Promise<{ file: string; changes: StringChange[] }> {
  const changes = await gitDiffStrings(opts)
  const entries = changes
    .filter((c) => c.kind !== 'deleted' && c.newValue !== undefined)
    .map((c) => ({ key: c.key, value: c.newValue! }))
  const outFile = path.join(opts.outDir, path.basename(opts.file))
  await collectToStaging({ entries, outFile })
  return { file: outFile, changes }
}
