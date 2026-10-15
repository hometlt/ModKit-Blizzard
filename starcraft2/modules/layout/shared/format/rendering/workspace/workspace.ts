/**
 * Workspace loading (L1 step 3): read a mod's `.SC2Layout` corpus into a
 * `layout-lang` `Store` by following `DescIndex.SC2Layout` `<Include>` entries,
 * across a dependency chain, so template/hookup resolution has every desc it
 * needs.
 *
 * IO is injected via {@link LayoutFileSource} so this module stays free of a
 * hard `fs`/vscode dependency and works over folders or any host-composed VFS source.
 * `fsLayoutSource` is the
 * folder-backed convenience used by tests and the reference-dump previews.
 */

import { Store } from '../../../layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../layout-engine/sc2-layout-core/core.js'

/** Reads layout files by their SC2Data-root-relative path (e.g. `UI/Layout/UI/GameUI.SC2Layout`). */
export interface LayoutFileSource {
  /** Human label for diagnostics/ordering (e.g. `core.sc2mod`). */
  readonly name: string
  /** Return file text, or undefined when the file is absent in this source. */
  read(relPath: string): Promise<string | undefined>
  /** Stable document URI for a relative path (Store key + source attribution). */
  uri(relPath: string): string
}

export interface LoadWorkspaceOptions {
  /**
   * `requiredtoload` build flags that are considered enabled. Includes gated by
   * a flag not in this set are skipped (default: none enabled → gated files
   * skipped). Case-insensitive.
   */
  enabledFlags?: Iterable<string>
  /** Include path of each source's desc index. Default `UI/Layout/DescIndex.SC2Layout`. */
  descIndexPath?: string
  /** Called once per loaded file (path resolved against the winning source). */
  onFile?: (relPath: string, source: LayoutFileSource) => void
}

export interface LoadWorkspaceReport {
  /** Relative paths loaded into the store, in load order. */
  loaded: string[]
  /** Includes skipped because their `requiredtoload` flag was disabled. */
  gatedSkipped: string[]
  /** Include paths that resolved to no source (missing files). */
  missing: string[]
}

interface IncludeEntry {
  path: string
  requiredToLoad?: string
}

/**
 * Load a layout workspace into a fresh `Store`. Sources are given in
 * dependency order (base game first, primary mod last); a file present in a
 * later source overrides an earlier one, and later declarations win in the
 * desc index — matching engine load-order precedence.
 */
export async function loadLayoutWorkspace(
  schema: SchemaRegistry,
  sources: readonly LayoutFileSource[],
  options: LoadWorkspaceOptions = {},
): Promise<{ store: Store; report: LoadWorkspaceReport }> {
  const store = new Store(schema)
  const report: LoadWorkspaceReport = { loaded: [], gatedSkipped: [], missing: [] }
  const enabled = new Set([...(options.enabledFlags ?? [])].map(f => f.toLowerCase()))
  const descIndexPath = options.descIndexPath ?? 'UI/Layout/DescIndex.SC2Layout'
  const seen = new Set<string>()

  // Resolve a relative path against the source chain: the LAST source that has
  // it wins (later mods override base-game files).
  const resolve = async (
    relPath: string,
  ): Promise<{ text: string; source: LayoutFileSource } | undefined> => {
    for (let i = sources.length - 1; i >= 0; i--) {
      const source = sources[i]!
      const text = await source.read(relPath)
      if (text !== undefined) return { text, source }
    }
    return undefined
  }

  const loadFile = async (relPath: string): Promise<void> => {
    const key = relPath.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    const found = await resolve(relPath)
    if (!found) {
      report.missing.push(relPath)
      return
    }

    store.updateDocument(found.source.uri(relPath), found.text)
    report.loaded.push(relPath)
    options.onFile?.(relPath, found.source)

    // Follow nested includes (DescIndex plus any file that itself includes).
    for (const inc of parseIncludes(found.text)) {
      if (inc.requiredToLoad && !enabled.has(inc.requiredToLoad.toLowerCase())) {
        report.gatedSkipped.push(inc.path)
        continue
      }
      await loadFile(normalizeIncludePath(inc.path))
    }
  }

  // Each source contributes its own desc index (later mods add/override files).
  for (const source of sources) {
    const text = await source.read(descIndexPath)
    if (text === undefined) continue
    // Bind the index doc itself, then walk its includes.
    if (!seen.has(descIndexPath.toLowerCase())) {
      seen.add(descIndexPath.toLowerCase())
      store.updateDocument(source.uri(descIndexPath), text)
      report.loaded.push(descIndexPath)
    }
    for (const inc of parseIncludes(text)) {
      if (inc.requiredToLoad && !enabled.has(inc.requiredToLoad.toLowerCase())) {
        report.gatedSkipped.push(inc.path)
        continue
      }
      await loadFile(normalizeIncludePath(inc.path))
    }
  }

  return { store, report }
}

/** Extract `<Include path="…" requiredtoload="…"/>` entries (comment-safe, attr-order-agnostic). */
export function parseIncludes(xmlText: string): IncludeEntry[] {
  const out: IncludeEntry[] = []
  const withoutComments = xmlText.replace(/<!--[\s\S]*?-->/g, '')
  const includeRe = /<Include\b([^>]*?)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = includeRe.exec(withoutComments)) !== null) {
    const attrs = m[1] ?? ''
    const path = attrValue(attrs, 'path')
    if (!path) continue
    const requiredToLoad = attrValue(attrs, 'requiredtoload')
    out.push(requiredToLoad !== undefined ? { path, requiredToLoad } : { path })
  }
  return out
}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const m = re.exec(attrs)
  return m ? (m[2] ?? m[3]) : undefined
}

/** Include paths are SC2Data-root-relative with `/`; normalize separators/case-insensitive leading slash. */
function normalizeIncludePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}
