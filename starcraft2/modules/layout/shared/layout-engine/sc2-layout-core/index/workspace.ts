/**
 * The archive/workspace substrate a {@link Store} runs on, declared as a contract instead of
 * imported from a concrete implementation.
 *
 * Until L4c that job was done by `@modkitx/lsp-mod`: `Store.s2ws` was a concrete StarCraft II
 * workspace class, every event payload carried that game's archive class, and `core.ts`
 * re-exported both under neutral aliases — one game's classes reached from a package under
 * names that did not say so. L4c moves those classes into `extensions/blizzard/starcraft-2`,
 * and a package may not depend on an extension: that edge is exactly what Rule 26 counts, and
 * it must not rise.
 *
 * So the coupling is structural. The extension's workspace and archive classes satisfy these
 * interfaces without either side importing the other, and `Store` is generic over the workspace
 * so a caller that passes the richer one keeps its extra members (string tables, font styles)
 * fully typed. `layout-lang` is itself a StarCraft II package — it parses `.SC2Layout` — and
 * moves into the extension at S7; this contract is what keeps that pending move from forcing a
 * package-to-extension dependency in the meantime.
 */

import * as path from 'path'
import { URI } from 'vscode-uri'

/** One mod archive, reduced to what the layout index actually reads off it. */
export interface LayoutArchive {
  readonly name: string
  readonly directory: string
  readonly uri: URI
  /** True for an archive that ships with the game rather than one authored in the workspace. */
  readonly native: boolean
  findFiles(pattern: string | string[]): Promise<string[]>
  readFile(filename: string): Promise<string>
}

/**
 * The archive set a `Store` indexes over. An implementation may carry more — the StarCraft II
 * one also owns the workspace's string tables and font styles — and a `Store` typed on it keeps
 * that surface; nothing here needs to know about it.
 */
export interface LayoutWorkspace {
  readonly archives: ReadonlySet<LayoutArchive>
  clear(): Promise<void>
  presetArchives(...sas: LayoutArchive[]): Promise<void>
  addArchive(sa: LayoutArchive): Promise<void>
  deleteArchive(sa: LayoutArchive): Promise<void>
  matchFileWorkspace(uri: URI): LayoutArchive | undefined
}

/**
 * Archive tracking and nothing else — the default when a `Store` is built without a workspace.
 * That is how `@modkitx/layout-render` and the schema-only suites use a `Store`: as a desc
 * index over documents they hand it directly, with no archive I/O, no strings and no styles.
 */
export class BasicLayoutWorkspace implements LayoutWorkspace {
  readonly archives = new Set<LayoutArchive>()

  async clear(): Promise<void> {
    this.archives.clear()
  }

  async presetArchives(...sas: LayoutArchive[]): Promise<void> {
    sas.forEach(sa => this.archives.add(sa))
  }

  async addArchive(sa: LayoutArchive): Promise<void> {
    this.archives.add(sa)
  }

  async deleteArchive(sa: LayoutArchive): Promise<void> {
    this.archives.delete(sa)
  }

  matchFileWorkspace(uri: URI): LayoutArchive | undefined {
    for (const sa of this.archives) {
      if (uri.fsPath.toString().startsWith(sa.directory + path.sep)) return sa
    }
    return undefined
  }
}
