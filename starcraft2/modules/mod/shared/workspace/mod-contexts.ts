/**
 * StarCraft II's one mod loader, as the host sees it: `openModContext` of `@modkit/vfs`'s
 * `ContentSources`, implemented structurally over {@link ModContextManager}.
 *
 * Every consumer — map worlds, the data and strings languages, triggers, Galaxy, models — loads
 * mods through this and nothing else. A context is:
 *
 *  - the load order (dependencies first, the opened package last), each layer with the content
 *    source it came from and its original path there, and why it is in the chain;
 *  - each layer's file list, and reads gated by it — a path the layer does not list is refused;
 *  - the session's view of the saved chain (owner decision 08.10): isolated unsaved text (`overlay`), a
 *    `revision` that changes with every edit or change on disk, and the chain's Data session
 *    (`chain-data.ts`) answering `data.*` questions — entities, authoring rows with ancestors, the
 *    ids of a Data space, existence, heirs, owner metadata — a few at a time. Full workspace
 *    projections use a revision-guarded lease with row/JSON-byte pages, never catalog XML in the
 *    answer; strings, Resources and every read in the same session see its overlays too.
 * Saved bytes and the canonical Data model are shared. Four inactive saved chains are retained;
 * active views pin their chain. The last context in an explicit session releases its overlays and
 * derived caches. Saved language inputs and their read-only link/reference views survive reconnects
 * through the loader LRU: four chains / 256 MiB of UTF-16 input text, names and document slots.
 * This bounds retained inputs, not parsed index heap/RSS; index construction keeps its own bounds.
 * Unsaved text never enters that retention. `invalidate` drops it and refreshes every active view.
 * Language sets prefer a source's indexed installed paths, with its native spellings, instead of
 * enumerating unrelated CASC assets first. Availability and membership share one generation-bound
 * cache; unsaved paths are merged, and sources without an index retain ordinary complete listing.
 * The reconstructable saved-byte cache retains at most 4096 entries / 64 MiB across chains, LRU;
 * an oversized active read remains usable without retention. This bounds that cache's payload,
 * not Data sessions, session overlays, parsed Resources or total process memory.
 * Derived Resources use the shared loader retention policy: at most four tree handles and 8 MiB
 * of UTF-16 keys across active contexts. Forgetting a handle detaches its byte/parse generation;
 * pending callers may finish and later queries reconstruct the complete tree. These are handle
 * and key limits, not limits on tree payload, active work, Data, overlays, heap or RSS.
 *
 * A file that belongs to no package opens inside `baseMods`: the host's setting for that file or
 * folder, or Void when there is none — almost every mod targets Void. A target is a host path (a
 * package, a file in one — also inside a packed package — or a loose file) or a path inside one of
 * the content sources. A replay opens inside the cache archives it names, and the editor's add-on
 * folders (wizards) are a layer of every context.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { TreeDataSource, TreeNodeRef } from '@modkit/sdk'
import type { LanguageWorkspaceSemanticInput } from '@modkit/sdk'
import {
  HOST_SOURCE_ID,
  ModContextManager,
  type LayerFiles,
  type PresetLayers,
  type ResolvedMod,
  type SourcePath,
} from './mod-context.js'
import type { ContentSourceStorage } from './content-source-provider.js'
import { createChainData, type ChainData, type ChainDataCache, type ChainLayer } from './chain-data.js'
import { createContextDataWorkspaceProjection } from './data-workspace-projection.js'
import type { ServedDataDocument } from './language-answer.js'
import type { GalaxyServedReferenceIndex } from '@modkit/blizzard-starcraft2/galaxy/served-references'
import type { ServedLinkIndex } from '@modkit/blizzard-starcraft2/galaxy/served-links'
import type { StyleServedDefinitionSet } from '@modkit/blizzard-starcraft2/style/served-definitions'
import type { LayoutServedDefinitionIndex } from '@modkit/blizzard-starcraft2/layout/served-definitions'
import type { StringsServedKeys } from '@modkit/blizzard-starcraft2/strings/served-keys'
import type { StringsServedDiagnostics } from '@modkit/blizzard-starcraft2/strings/served-diagnostics'
import type { ServedLanguageOwner, ServedRenameQuestion, ServedFeatureQuestion } from '@modkit/blizzard-starcraft2/mod/served-language-owner'
import { lineStartOffsets, positionAt } from '../../../../shared/xml/text-position.js'
import { contextStrings, type ContextStrings } from './context-strings.js'
import { layerRoot } from '../../services/resources/src/layer-root.js'
import type { ModParseResult } from '../core/index.js'
import { LoaderMetadataCache } from './loader-metadata-cache.js'

export const SC2_GAME_ID = 'blizzard/starcraft-2'
/** What a file outside any package is read inside when the host sets nothing. */
export const SC2_DEFAULT_BASE_MODS: readonly string[] = Object.freeze(['Mods/Void.SC2Mod'])

export interface Sc2ModContextRequest {
  readonly schemaVersion: 1
  /** A host path, or a path inside one of the content sources. */
  readonly target: string | SourcePath
  readonly baseMods?: readonly string[]
  readonly locales?: readonly string[]
  /** The host's editor/workspace scope; unsaved state is visible only within this scope. */
  readonly sessionId?: string
}

export interface Sc2ModContextLayer {
  readonly id: string
  readonly displayName: string
  readonly sourceId: string
  readonly sourcePath: string
  readonly role: 'dependency' | 'base' | 'primary'
  readonly provenance: 'declared' | 'implicit' | 'setting' | 'opened'
  /**
   * `package` is a mod package the game reads as a whole (`Core.SC2Mod`, a packed `Foo.SC2Map`);
   * `files` is a layer that is no package, such as an editor wizard folder. A reader asks the
   * loader instead of judging the path itself.
   */
  readonly kind: 'package' | 'files'
  /** Content identity of the layer, when the game knows one (a cache archive's hash). */
  readonly fingerprint?: string
}

/**
 * Where a target lies, answered without resolving its chain. `package` names the package the
 * target belongs to — the same source and path its primary layer would carry; `loose` is a file
 * outside any package, read over the base mods; `missing` is a target `open` would refuse;
 * `foreign` is a file outside any package of a type StarCraft II does not read, which another
 * game in the same window may place (a Warcraft III `.j` script).
 */
export type Sc2ModPackagePlacement =
  | { readonly kind: 'package'; readonly sourceId: string; readonly path: string; readonly displayName: string }
  | { readonly kind: 'loose' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'foreign' }

/**
 * File types StarCraft II reads outside a package: every extension its codecs and languages
 * declare (a test holds the manifests to this list), the assets its packages carry, and
 * extension-less documents such as DocumentInfo or Objects.
 */
const SC2_FILE_EXTENSIONS = new Set([
  'blizwiz', 'galaxy', 's2mh', 's2ml', 'sc2bank', 'sc2campaign', 'sc2cutscene', 'sc2layout',
  'sc2lib', 'sc2map', 'sc2mod', 'sc2replay', 'sc2scene', 'sc2style', 'stormcutscene', 'triggerlib', 'triggers',
  'txt', 'xml',
  's2ma', 's2mv', 's2qh', 's2ql', 's2qv', 'sc2components', 'sc2hotkeys', 'sc2interface', 'sc2locale', 'sc2archive',
  'sc2assets', 'sc2data', 'json', 'version',
  'm3', 'm3a', 'm3h', 'dds', 'tga', 'ogg', 'wav', 'mp3', 'ogv', 'webm', 'fxa', 'fxb', 'ttf', 'otf',
])

function looseOrForeign(target: string): Sc2ModPackagePlacement {
  const name = target.replaceAll('\\', '/').replace(/\/+$/u, '').split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return Object.freeze(
    dot <= 0 || SC2_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
      ? { kind: 'loose' as const }
      : { kind: 'foreign' as const },
  )
}

export interface Sc2ModContext {
  readonly schemaVersion: 1
  /** Present only when Host supplies the classifier needed by every installed language surface. */
  readonly languageModel?: 'server'
  readonly gameId: string
  readonly contextId: string
  readonly sessionId?: string
  readonly layers: readonly Sc2ModContextLayer[]
  readonly unresolved: readonly string[]
  readonly diagnostics: readonly unknown[]
  files(
    layerId: string,
    page: { readonly cursor?: string; readonly limit: number; readonly prefix?: string },
  ): Promise<{ readonly items: readonly string[]; readonly nextCursor?: string }>
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
  locate(path: string): Promise<{ readonly layerId: string; readonly path: string } | undefined>
  /**
   * Paged game-defined questions: `data.entities`, `data.authoring`, `data.ids`, `data.exists`,
   * `data.heirs`, `data.metadata`, `data.strings`, `data.language` (a language feature's needs in
   * one question, `language-answer.ts`), `data.workspace` (full projection open/page/close),
   * `galaxy.references`, `galaxy.hover`, `galaxy.definition`, `galaxy.signature-help`,
   * `galaxy.completion`, `galaxy.diagnostics` (answers over
   * the chain's Galaxy scripts), `style.definition`, `style.references`
   * (declarations across the chain's style sheets), `layout.definition`, `layout.hover` and
   * `layout.completion`, `layout.diagnostics` (over the chain's layouts and sheets), `strings.keys`
   * (a GameStrings key across the chain's catalogs, layouts and scripts), `strings.hover`, `strings.diagnostics` (a catalog's
   * markup against the chain), `data.references` (an entity's references across the chain's
   * catalogs), `language.rename`, `language.prepare-rename` (bounded plans from the same owners),
   * `language.verify` (closed documents of all supported languages), `language.feature` (remaining
   * canonical semantic surfaces, bounded identity/result projection) and `resources.tree`.
   */
  query(request: unknown, signal?: AbortSignal): Promise<unknown>
  /** Changes with this session's overlays or a change to the saved chain. */
  readonly revision: string
  /**
   * Unsaved editor text over files of the chain's layers (`text` absent removes an overlay). File
   * reads, listings, Data questions and strings in this session see it; other sessions are isolated.
   */
  overlay(changes: readonly Sc2ModContextOverlay[]): Promise<{ readonly revision: string }>
  /** Files of the chain changed on disk: the next read and question see them. */
  invalidate(): Promise<{ readonly revision: string }>
  /** Build the chain's Data session ahead of the first question. */
  prepare(signal?: AbortSignal): Promise<void>
  dispose(): Promise<void>
}

/** One overlay change: a layer's file by its path in the layer, and its unsaved text. */
export interface Sc2ModContextOverlay {
  readonly layerId: string
  readonly path: string
  /** The editor's text; absent removes the overlay, so the file reads from its source again. */
  readonly text?: string
}

export interface Sc2ModContextsOptions {
  /** The host's content sources, in lookup order — the installation folder before CASC. */
  readonly sources: () => ReadonlyMap<string, ContentSourceStorage>
  /** A host folder as a content source — the folder an opened package sits in. */
  readonly hostFolder: (directory: string) => ContentSourceStorage
  /** Sources the editor loads whatever is open (wizard folders): a layer of every context. */
  readonly addOns?: () => ReadonlyMap<string, ContentSourceStorage>
  /** The cache archives a replay (its bytes) depends on, as layers of the content sources. */
  readonly replayLayers?: (bytes: Uint8Array) => Promise<PresetLayers>
  /**
   * The content-source path of a host path that is no file on disk but lies inside storage the
   * sources read (a member of the game's CASC below its installation folder), if any.
   */
  readonly storagePathOf?: (hostPath: string) => SourcePath | undefined
  readonly defaultBaseMods?: readonly string[]
  /** Where saved chains keep the parses of their leading stock layers (`data-cache-node.ts`). */
  readonly dataCache?: ChainDataCache
  /**
   * The host's language of a file by its layer-relative path (sdk `ContentSourceModuleContext.
   * languageFiles`): the mixed language set behind the cross-language link index is classified by
   * it, as the host's language snapshot is. Without it that set is not served.
   */
  readonly languageFiles?: (path: string) => { readonly languageId?: string; readonly candidates: readonly string[] }
}

const PACKAGE = /\.(sc2mod|sc2map|sc2campaign)$/iu
const REPLAY = /\.sc2replay$/iu
/** The largest replay whose archives a context reads out of it. */
const MAXIMUM_REPLAY = 64 * 1024 * 1024
const MAXIMUM_PAGE = 10_000
const MAXIMUM_QUERY_REFS = 1024
/** Inactive saved chains retained in memory; active session views pin their chain. */
const MAXIMUM_SERVERS = 4
const MAXIMUM_OVERLAY_BYTES = 64 * 1024 * 1024
/** A Galaxy script or style sheet read for a served answer: the snapshot path's document bound. */
const MAXIMUM_GALAXY_BYTES = 16 * 1024 * 1024
const galaxyDecoder = new TextDecoder('utf-8', { fatal: true })
/** Recoverable saved reads, separate from active results and session-owned models/overlays. */
const MAXIMUM_SAVED_BYTE_ENTRIES = 4096
const MAXIMUM_SAVED_BYTES = 64 * 1024 * 1024
const encoder = new TextEncoder()

/** Exact saved UTF-8 text equality, including transport BOM and rejecting lossy surrogate encoding. */
function matchesSavedText(text: string, bytes: Uint8Array): boolean {
  const encoded = encoder.encode(text)
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return bytes.byteLength - bom === encoded.byteLength &&
    Buffer.from(bytes.buffer, bytes.byteOffset + bom, bytes.byteLength - bom).equals(encoded) &&
    text === galaxyDecoder.decode(bytes)
}

/** Every question a context answers, for a refusal that says what it does answer. */
const ANSWERED_QUESTIONS =
  'data.entities, data.authoring, data.ids, data.exists, data.heirs, data.metadata, data.strings, data.language, data.workspace, galaxy.references, galaxy.hover, galaxy.definition, galaxy.signature-help, galaxy.completion, galaxy.diagnostics, style.definition, style.references, layout.definition, layout.hover, layout.completion, layout.diagnostics, strings.keys, strings.hover, strings.diagnostics, data.references, language.feature, language.rename, language.prepare-rename, language.verify and resources.tree'
/** The data questions that name entities, each answered from the chain's Data session. */
const ENTITY_QUESTIONS = new Set(['data.entities', 'data.authoring', 'data.exists', 'data.heirs'])

/** The references of an entity question, or a refusal. */
function entityRefs(request: unknown): readonly { readonly namespace: string; readonly entityId: string }[] {
  const value = request as { readonly kind?: unknown; readonly refs?: unknown } | null
  if (typeof value?.kind !== 'string' || !ENTITY_QUESTIONS.has(value.kind)) {
    throw new Error(`StarCraft II mod contexts answer ${ANSWERED_QUESTIONS}, not ${String(value?.kind)}`)
  }
  const refs = value.refs
  if (
    !Array.isArray(refs) ||
    refs.length > MAXIMUM_QUERY_REFS ||
    !refs.every(
      ref =>
        typeof ref?.namespace === 'string' && ref.namespace !== '' &&
        typeof ref?.entityId === 'string' && ref.entityId !== '',
    )
  ) {
    throw new Error(`${value.kind} needs up to ${MAXIMUM_QUERY_REFS} namespace/entityId references`)
  }
  return refs
}

const canonical = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '')

/**
 * Where a package keeps its assets, as the mod, campaign and map codecs declare them (codec.json
 * `container.assetRoots`: Base.SC2Assets, *.SC2Assets, the root). The game spells an asset by its
 * path under that root (`Assets\Textures\x.dds`); a path that already names a component
 * (`Base.SC2Data/…`, `enUS.SC2Assets/…`) is only itself.
 */
const COMPONENT = /^[^/]+\.sc2[a-z]+\//u
const localeAssetComponents = new WeakMap<LayerFiles, readonly string[]>()
function assetSpellings(files: LayerFiles, relative: string, locales: readonly string[]): readonly string[] {
  if (COMPONENT.test(relative)) return [relative]
  let components = localeAssetComponents.get(files)
  if (components === undefined) {
    const found = new Set<string>()
    for (const file of files.byPath.keys()) {
      const component = file.slice(0, Math.max(0, file.indexOf('/')))
      if (component.endsWith('.sc2assets') && component !== 'base.sc2assets') found.add(component)
    }
    components = Object.freeze([...found].sort())
    localeAssetComponents.set(files, components)
  }
  // The context's locales first, then any other locale's component.
  const preferred = locales.map(locale => `${locale.toLowerCase()}.sc2assets`)
  const ordered = [
    ...preferred.filter(component => components.includes(component)),
    ...components.filter(component => !preferred.includes(component)),
  ]
  return [relative, `base.sc2assets/${relative}`, ...ordered.map(component => `${component}/${relative}`)]
}

async function statOf(target: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await fs.stat(target)
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
  } catch {
    return undefined
  }
}

/** A loaded chain's server: its overlays and revision, its Data session and its strings. */
interface ChainServer {
  /** Overlay by layer and path (lower-cased), with the layer's VFS path and the path as spelled. */
  readonly overlays: Map<string, { readonly vfsPath: string; readonly path: string; readonly text: string }>
  revision: number
  data?: ChainData
  strings?: ContextStrings | undefined
  /** Resource parses/bytes include this view's overlays and never enter the saved cache. */
  resources: { readonly bytes: Map<string, Promise<Uint8Array>>; readonly parsed: Map<string, ModParseResult> }
  /** Private retention namespace; a reopened session cannot reuse the previous view's trees. */
  readonly resourceScope: number
  references: number
  /** The chain's Galaxy files indexed at a revision, for the `galaxy.*` questions (built on first use). */
  galaxy?: { readonly index: GalaxyServedReferenceIndex; revision: number; keep?: string; carried?: boolean;
    building?: Promise<void> | undefined }
  /** The chain's style sheets at a revision, for `style.definition` (read on first use). */
  styles?: { readonly sheets: StyleServedDefinitionSet; revision: number; building?: Promise<void> | undefined }
  /**
   * The chain's held documents of the mixed SC2 languages and style sheets at a revision, by the
   * host's classifier, and what is built over them: the cross-language link index and the strings
   * markup checker (each on first use).
   */
  languageDocuments?: {
    incomplete?: boolean
    documents?: readonly { readonly layerId: string; readonly path: string; readonly languageId: string; readonly text: string }[]
    /** Changes since the retained inputs; absent means a full read is required. */
    dirty?: Set<string>
    revision: number
    building?: Promise<void> | undefined
    links?: ServedLinkIndex
    /** The mixed-language documents as `data.references` reads them: the same objects all revision long. */
    dataDocuments?: readonly ServedDataDocument[]
    /** Canonical reference views survive revisions only while their unchanged inputs remain alive. */
    dataDocumentViews?: WeakMap<object, ServedDataDocument>
    strings?: StringsServedDiagnostics
  }
  languageOwner?: ServedLanguageOwner
  /** Lazy metadata only: the strongest owner of each content path, never its bytes. */
  languageAssets?: { revision: number; inputs: readonly LanguageWorkspaceSemanticInput[];
    paths: readonly string[]; owners: readonly number[]; incomplete: boolean }
  /** The chain's layouts and sheets at a revision, for `layout.*` (read on first use). */
  layouts?: { readonly index: LayoutServedDefinitionIndex; revision: number; keep?: string; carried?: boolean;
    building?: Promise<void> | undefined }
  /** The chain's string catalogs and layouts at a revision, for `strings.keys` (read on first use). */
  stringKeys?: { readonly keys: StringsServedKeys; revision: number; building?: Promise<void> | undefined }
}

/** One saved model, with independent copy-on-write views for its editor/workspace sessions. */
interface SavedChain {
  data?: ChainData
  languageDocuments?: SavedLanguageDocuments
  readonly views: Map<string, ChainServer>
}

/** Immutable saved inputs; lazy read-only query indexes hold no session reader or overlay closure. */
interface SavedLanguageDocuments {
  readonly documents: NonNullable<NonNullable<ChainServer['languageDocuments']>['documents']>
  readonly incomplete: boolean
  links?: ServedLinkIndex
  dataDocuments?: readonly ServedDataDocument[]
}

export function createSc2ModContexts(options: Sc2ModContextsOptions) {
  const manager = new ModContextManager(options.sources, options.hostFolder, options.addOns)
  /**
   * Saved models by load order and unresolved dependencies. Contexts pin their chain; only idle
   * chains are evicted. A session owns its overlays and derived model, and shares saved parses.
   */
  const chains = new Map<string, SavedChain>()
  let savedGeneration = 0
  // Liberty's native language inputs alone occupy about146 MiB of UTF-16 text/metadata.
  // The aggregate bound admits that canonical model instead of evicting it immediately.
  const savedLanguages = new LoaderMetadataCache<SavedLanguageDocuments>(4, 256 * 1024 * 1024,
    value => value.documents.reduce((bytes, document) => bytes + 512 +
      2 * (document.layerId.length + document.path.length + document.languageId.length + document.text.length), 0))
  let nextResourceScope = 0
  /** Keep active identities registered, and bound the saved chains retained after their last view. */
  const trim = (): void => {
    const idle = [...chains].filter(([, chain]) => ![...chain.views.values()].some(view => view.references > 0))
    for (const [key] of idle.slice(0, Math.max(0, idle.length - MAXIMUM_SERVERS))) {
      savedLanguages.deletePrefix(key)
      chains.delete(key)
    }
  }
  const serverFor = (key: string, sessionId: string | undefined): { chain: SavedChain; server: ChainServer } => {
    const chain = chains.get(key) ?? { views: new Map<string, ChainServer>() }
    const scope = sessionId ?? ''
    const server = chain.views.get(scope) ?? {
      overlays: new Map(), revision: 0, references: 0,
      resources: { bytes: new Map(), parsed: new Map() },
      resourceScope: nextResourceScope++,
    }
    server.references += 1
    chain.views.set(scope, server)
    chains.delete(key)
    chains.set(key, chain)
    trim()
    return { chain, server }
  }
  /** Native suffix used both to collect language inputs and to check overlay dependencies. */
  const extensionOf = (file: string): string => {
    const name = file.slice(file.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  }
  const styleInputs = ['sc2style']
  const layoutInputs = ['sc2layout', 'sc2style', 'txt']
  /** Match overlay identities to retained language inputs without hashing or copying their text. */
  const languageInputKey = (layerId: string, file: string): string =>
    `${layerId}\u0000${canonical(file).replace(/^\/+/u, '').toLowerCase()}`
  /** Keep finished language indexes across unrelated edits; pending or stale builds stay guarded. */
  const changed = (server: ChainServer, changes?: readonly Sc2ModContextOverlay[]): void => {
    const before = server.revision
    server.revision += 1
    const documents = server.languageDocuments
    if (documents !== undefined) {
      if (changes === undefined) delete documents.dirty
      else if (documents.dirty !== undefined) {
        for (const change of changes) {
          documents.dirty.add(languageInputKey(change.layerId, change.path))
          // Excess edit metadata falls back to a full read; no language input is truncated.
          if (documents.dirty.size > MAXIMUM_PAGE) { delete documents.dirty; break }
        }
      }
    }
    if (changes !== undefined && server.galaxy?.revision === before && server.galaxy.building === undefined &&
        !changes.some(change => extensionOf(canonical(change.path)) === 'galaxy')) {
      server.galaxy.revision = server.revision
      server.galaxy.carried = true
    }
    if (changes !== undefined && server.styles?.revision === before && server.styles.building === undefined &&
        !changes.some(change => styleInputs.includes(extensionOf(canonical(change.path))))) {
      server.styles.revision = server.revision
    }
    if (changes !== undefined && server.layouts?.revision === before && server.layouts.building === undefined &&
        !changes.some(change => layoutInputs.includes(extensionOf(canonical(change.path))))) {
      server.layouts.revision = server.revision
      server.layouts.carried = true
    }
    server.data?.refresh(changes)
    if (changes === undefined) server.strings = undefined
    else server.strings?.invalidate(changes.map(change => canonical(change.path).replace(/^\/+/u, '')))
  }
  /** Four recoverable Resources trees across views; live Data, overlays and identities stay pinned. */
  const resourceTrees = new LoaderMetadataCache<{ readonly revision: number; readonly tree: Promise<TreeDataSource> }>(
    4, 8 * 1024 * 1024, () => 0,
  )
  const savedBytes = new Map<string, { reading: Promise<Uint8Array>; retainedBytes: number }>()
  let retainedSavedBytes = 0
  /** A settled/pending entry may have been replaced or invalidated while its read was in flight. */
  const removeSavedBytes = (key: string, entry: { retainedBytes: number }): void => {
    if (savedBytes.get(key) !== entry) return
    savedBytes.delete(key)
    retainedSavedBytes -= entry.retainedBytes
  }
  /** Evict only recoverable saved read results, preserving every caller's in-flight promise. */
  const trimSavedBytes = (): void => {
    while (savedBytes.size > MAXIMUM_SAVED_BYTE_ENTRIES || retainedSavedBytes > MAXIMUM_SAVED_BYTES) {
      const oldest = savedBytes.entries().next().value
      if (oldest === undefined) break
      removeSavedBytes(oldest[0], oldest[1])
    }
  }
  /** Saved changes invalidate the base and every active view; overlays remain local. */
  const invalidateSaved = (sourceId?: string): void => {
    savedGeneration += 1
    savedLanguages.clear()
    manager.invalidate(sourceId)
    resourceTrees.clear()
    savedBytes.clear()
    retainedSavedBytes = 0
    for (const chain of chains.values()) {
      chain.data?.refresh()
      for (const server of chain.views.values()) {
        server.resources.bytes.clear()
        server.resources.parsed.clear()
        changed(server)
      }
    }
  }
  const defaults = options.defaultBaseMods ?? SC2_DEFAULT_BASE_MODS

  /**
   * Where a host path is: a package (itself, the nearest enclosing root, or the packed package a
   * path inside one names — `C:/Maps/Foo.SC2Map/MapScript.galaxy`), a path inside storage the
   * sources read, or neither (a loose file). A member of a container the sources cannot read — a
   * file inside a `.zip` — is a loose file too: it has no package to name, only its base mods; so
   * is a file not yet saved into an existing folder. A path under nothing that exists is refused.
   */
  const locate = async (
    target: string,
  ): Promise<{ readonly root?: string; readonly source?: SourcePath; readonly member?: true }> => {
    const kind = await statOf(target)
    if (kind === undefined) {
      let outer = path.dirname(target)
      while ((await statOf(outer)) === undefined && path.dirname(outer) !== outer) outer = path.dirname(outer)
      const outerKind = await statOf(outer)
      if (outerKind === 'file' && PACKAGE.test(path.basename(outer))) return { root: outer }
      const source = options.storagePathOf?.(target)
      if (source !== undefined) return { source }
      if (outerKind === 'file') return { member: true }
      if (outerKind === 'directory' && outer === path.dirname(target)) {
        const root = await manager.findModRoot(target)
        return root === undefined ? { member: true } : { root }
      }
      throw new Error(`${target} does not exist`)
    }
    if (PACKAGE.test(path.basename(target))) return { root: target }
    // `findModRoot` starts from a file's folder; a folder target starts from itself.
    const root = await manager.findModRoot(kind === 'directory' ? path.join(target, 'x') : target)
    return root === undefined ? {} : { root }
  }

  /** A replay's archives, when the target is a replay and the game can find them. */
  const replayPreset = async (name: string, read: () => Promise<Uint8Array>): Promise<PresetLayers | undefined> =>
    REPLAY.test(name) && options.replayLayers !== undefined ? options.replayLayers(await read()) : undefined

  /** A path inside one of the sources: its package, a replay inside its archives, or a loose file. */
  const inSource = async (target: SourcePath, baseMods: readonly string[]): Promise<ResolvedMod> => {
    const storage = options.sources().get(target.sourceId)
    const preset = await replayPreset(target.path, () => {
      if (storage === undefined) throw new Error(`no content source '${target.sourceId}' is configured`)
      return storage.read(canonical(target.path).replace(/^\/+/u, ''), MAXIMUM_REPLAY)
    })
    return manager.resolveInSource(target, preset === undefined ? baseMods : [], preset)
  }

  async function open(request: Sc2ModContextRequest): Promise<Sc2ModContext> {
    const target = request?.target
    if (
      request?.schemaVersion !== 1 ||
      (request.sessionId !== undefined && (typeof request.sessionId !== 'string' ||
        request.sessionId.length === 0 || request.sessionId.length > 128 || /[\u0000-\u001f]/u.test(request.sessionId))) ||
      !(
        (typeof target === 'string' && target !== '') ||
        (typeof target === 'object' && target !== null &&
          typeof target.sourceId === 'string' && target.sourceId !== '' && typeof target.path === 'string')
      )
    ) {
      throw new Error('Invalid StarCraft II mod context request')
    }
    const baseMods = request.baseMods ?? defaults
    let root: string | undefined
    let resolved: ResolvedMod
    if (typeof target === 'string') {
      const located = await locate(target)
      root = located.root
      if (root !== undefined) resolved = await manager.resolve(root)
      else if (located.source !== undefined) resolved = await inSource(located.source, baseMods)
      else {
        const preset =
          located.member === true
            ? undefined
            : await replayPreset(target, async () => new Uint8Array(await fs.readFile(target)))
        resolved = await manager.resolveLoose(target, preset === undefined ? baseMods : [], preset)
      }
    } else resolved = await inSource(target, baseMods)
    const order = resolved.order
    const layers = await Promise.all(
      order.map(async (vfsPath, index): Promise<Sc2ModContextLayer> => {
        const source = await manager.sourceOf(vfsPath)
        const opened = index === order.length - 1
        const provenance = opened ? 'opened' : (resolved.layerProvenance.get(vfsPath.toLowerCase()) ?? 'declared')
        const fingerprint = resolved.fingerprints.get(vfsPath.toLowerCase())
        return Object.freeze({
          ...(fingerprint === undefined ? {} : { fingerprint }),
          id: `layer:${index}`,
          // A wizard folder is a whole source, not a package in one; its id says nothing to a reader.
          displayName:
            source.path !== ''
              ? path.posix.basename(source.path)
              : source.addOn === true
                ? 'Editor wizards'
                : source.id,
          sourceId: source.id,
          sourcePath: source.path,
          role: opened ? 'primary' : provenance === 'setting' && source.addOn !== true ? 'base' : 'dependency',
          provenance,
          kind: source.addOn !== true && PACKAGE.test(path.posix.basename(source.path)) ? 'package' : 'files',
        })
      }),
    )
    const vfsPathOf = (layerId: string): string => {
      const index = layers.findIndex(layer => layer.id === layerId)
      if (index < 0) throw new Error(`no layer '${layerId}' in this context`)
      return order[index] as string
    }
    const savedChainKey = JSON.stringify([
      order.map(item => item.toLowerCase()), resolved.unresolved,
    ])
    const { chain, server } = serverFor(savedChainKey, request.sessionId)
    const overlayKey = (vfsPath: string, filePath: string): string =>
      `${vfsPath.toLowerCase()}\u0000${canonical(filePath).replace(/^\/+/u, '').toLowerCase()}`
    /** A layer's files as listed, with the files only an overlay holds (a new, unsaved file). */
    const listing = async (layerId: string): Promise<readonly string[]> => {
      const vfsPath = vfsPathOf(layerId)
      const listed = await resolved.files(vfsPath)
      const added = [...server.overlays.values()]
        .filter(overlay => overlay.vfsPath === vfsPath && !listed.byPath.has(overlay.path.toLowerCase()))
        .map(overlay => overlay.path)
      return added.length === 0 ? listed.list : Object.freeze([...listed.list, ...added].sort((left, right) => (left < right ? -1 : 1)))
    }
    /**
     * A file's bytes on disk or in its source, read once while it stays the same: the Data session
     * and every session's Resources tree share this saved cache. Unsaved bytes never enter it.
     */
    const storedBytes = (vfsPath: string, filePath: string): Promise<Uint8Array | undefined> => {
      const key = `${vfsPath.toLowerCase()}/${canonical(filePath).replace(/^\/+/u, '').toLowerCase()}`
      const known = savedBytes.get(key)
      if (known !== undefined) {
        savedBytes.delete(key)
        savedBytes.set(key, known)
        return known.reading
      }
      let entry: { readonly reading: Promise<Uint8Array>; retainedBytes: number }
      const reading = resolved.read(vfsPath, filePath).then(bytes => {
        if (bytes === undefined) throw new Error(`${filePath} is not a file of ${vfsPath}`)
        if (savedBytes.get(key) === entry) {
          if (bytes.byteLength > MAXIMUM_SAVED_BYTES) removeSavedBytes(key, entry)
          else {
            entry.retainedBytes = bytes.byteLength
            retainedSavedBytes += bytes.byteLength
            trimSavedBytes()
          }
        }
        return bytes
      })
      entry = { reading, retainedBytes: 0 }
      savedBytes.set(key, entry)
      trimSavedBytes()
      reading.catch(() => {
        removeSavedBytes(key, entry)
      })
      return reading.catch(() => undefined)
    }
    const readFile = async (layerId: string, filePath: string, maxBytes: number): Promise<Uint8Array> => {
      const vfsPath = vfsPathOf(layerId)
      const overlay = server.overlays.get(overlayKey(vfsPath, filePath))
      const bytes = overlay !== undefined ? encoder.encode(overlay.text) : await storedBytes(vfsPath, filePath)
      if (bytes === undefined) throw new Error(`${filePath} is not a file of ${layerId}`)
      if (bytes.byteLength > maxBytes) throw new Error(`${filePath} is larger than ${maxBytes} bytes`)
      return bytes
    }
    const chainLayers: readonly ChainLayer[] = layers.map(layer => ({
      id: layer.id,
      sourcePath: layer.sourcePath,
      rootId: layerRoot(layer).uri,
      ...(layer.fingerprint === undefined ? {} : { fingerprint: layer.fingerprint }),
    }))
    const chainReader = { files: listing, read: readFile }
    const savedReader = {
      files: async (layerId: string) => (await resolved.files(vfsPathOf(layerId))).list,
      read: async (layerId: string, filePath: string, maxBytes: number) => {
        const bytes = await storedBytes(vfsPathOf(layerId), filePath)
        if (bytes === undefined) throw new Error(`${filePath} is not a file of ${layerId}`)
        if (bytes.byteLength > maxBytes) throw new Error(`${filePath} is larger than ${maxBytes} bytes`)
        return bytes
      },
    }
    if (chain.data === undefined) chain.data = createChainData('sc2-mod-context', {
      layers: chainLayers, reader: savedReader, incomplete: resolved.unresolved.length > 0,
      ...(options.dataCache === undefined ? {} : { cache: options.dataCache }),
    })
    else chain.data.rebind(chainLayers, savedReader, resolved.unresolved.length > 0)
    if (server.data === undefined) {
      server.data = createChainData('sc2-mod-context', {
        layers: chainLayers,
        reader: chainReader,
        incomplete: resolved.unresolved.length > 0,
        base: chain.data,
        hasOverlays: async saved => {
          const revision = server.revision, generation = savedGeneration
          const documents = new Map(saved.map(document =>
            [`${document.rootId}\u0000${canonical(document.path).toLowerCase()}`, document.text] as const))
          for (const overlay of server.overlays.values()) {
            const index = order.indexOf(overlay.vfsPath)
            if (index < 0) return true
            const layer = chainLayers[index]!
            if (chain.data?.dependsOn(layer.id, overlay.path) === false) continue
            // The canonical UTF-8 reader removes one transport BOM from editor bytes too.
            const overlayText = overlay.text.charCodeAt(0) === 0xfeff ? overlay.text.slice(1) : overlay.text
            const text = documents.get(`${layer.rootId}\u0000${canonical(`${layer.sourcePath}/${overlay.path}`).toLowerCase()}`)
            if (text !== undefined) {
              if (text !== overlayText) return true
            } else {
              // Includes manifests are dependencies, but not catalog documents. Read only that
              // saved input; never remove the editor overlay after proving equality.
              try {
                const bytes = await storedBytes(overlay.vfsPath, overlay.path)
                if (bytes === undefined || !matchesSavedText(overlayText, bytes)) return true
              }
              catch { return true }
            }
          }
          return server.revision !== revision || savedGeneration !== generation
        },
      })
    } else server.data.rebind(chainLayers, chainReader, resolved.unresolved.length > 0)
    const chainData = server.data
    /** The Data session's answer to one data question, with the chain's revision. */
    const dataAnswer = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const kind = (request as { readonly kind?: unknown } | null)?.kind
      const session = await chainData.session(signal)
      signal?.throwIfAborted()
      const revision = String(server.revision)
      if (kind === 'data.ids') {
        const namespace = (request as { readonly namespace?: unknown }).namespace
        if (typeof namespace !== 'string' || namespace === '') throw new TypeError('data.ids needs a namespace')
        return Object.freeze({ revision, complete: session.complete(), ids: session.ids(namespace) })
      }
      if (kind === 'data.metadata') {
        return Object.freeze({ revision, complete: session.complete(), metadata: session.metadata() ?? null })
      }
      const refs = entityRefs(request)
      if (kind === 'data.entities') return Object.freeze({ revision, entities: session.definitions(refs) })
      if (kind === 'data.exists') return Object.freeze({ revision, complete: session.complete(), exists: session.exists(refs) })
      if (kind === 'data.heirs') return Object.freeze({ revision, heirs: session.heirs(refs) })
      const chains = (request as { readonly chains?: unknown }).chains === true
      return Object.freeze({ revision, index: session.authoring(refs, { chains }) })
    }
    const contextLocales = request.locales ?? []
    /** The chain's strings, read once while its files stay the same (an overlay forgets them). */
    const stringsChain = (): ContextStrings => {
      let chain = server.strings
      if (chain === undefined) {
        chain = contextStrings({
          layers: layers.map(layer => ({ ...layer, rootId: layerRoot(layer).uri })),
          files: listing,
          read: readFile,
        })
        server.strings = chain
      }
      return chain
    }
    const contextId = JSON.stringify([
      order.map(item => item.toLowerCase()),
      root === undefined && !PACKAGE.test(layers.at(-1)?.sourcePath ?? '')
        ? [
            typeof target === 'string'
              ? canonical(target).toLowerCase()
              : [target.sourceId, canonical(target.path).toLowerCase()],
            baseMods,
          ]
        : [],
      request.locales ?? [],
      request.sessionId ?? null,
      resolved.unresolved,
    ])
    /**
     * The chain as Resources read it: the loader's listings and bytes with the editor's unsaved text
     * over them, so a card or a tree node shows what the editor shows (owner decision 07.10, 5A).
     */
    const servedChain: Pick<ResolvedMod, 'order' | 'files' | 'read'> = {
      order,
      async files(vfsPath) {
        const listed = await resolved.files(vfsPath)
        const added = [...server.overlays.values()]
          .filter(overlay => overlay.vfsPath === vfsPath && !listed.byPath.has(overlay.path.toLowerCase()))
          .map(overlay => overlay.path)
        if (added.length === 0) return listed
        const list = Object.freeze([...listed.list, ...added].sort((left, right) => (left < right ? -1 : 1)))
        return { list, byPath: new Map(list.map(path => [path.toLowerCase(), path] as const)) }
      },
      async read(vfsPath, filePath) {
        const overlay = server.overlays.get(overlayKey(vfsPath, filePath))
        return overlay !== undefined ? encoder.encode(overlay.text) : storedBytes(vfsPath, filePath)
      },
    }
    const resourceTree = async (): Promise<TreeDataSource> => {
      const key = `${server.resourceScope}:${contextId}\0`
      const resources = server.resources
      let memo!: Promise<{ readonly revision: number; readonly tree: Promise<TreeDataSource> }>
      memo = resourceTrees.get(key, () => {
        const revision = server.revision
        // Opening a context does not import the full Resources/Galaxy/Layout parser closure.
        const tree = import('../../services/resources/src/effective-tree.js').then(({ effectiveModResourceTree }) =>
          effectiveModResourceTree(servedChain, layers, `${contextId}@${revision}`, resources, request.locales?.[0],
          // One catalog per chain: the tree reads the Data session the languages and cards read.
          async () => {
            const { entries, invalid } = (await chainData.session()).catalog()
            return { entries, invalid, layers: chainLayers }
          }))
        void tree.catch(() => resourceTrees.delete(key, memo))
        return Promise.resolve({ revision, tree })
      }, () => {
        // Detach this generation; an evicted pending tree can still finish for its original caller.
        if (server.resources === resources) server.resources = { bytes: new Map(), parsed: new Map() }
      })
      const record = await memo
      if (record.revision !== server.revision) {
        // Keep unchanged parses after an edit; overlay/invalidation already forgot affected inputs.
        const current = server.resources
        resourceTrees.delete(key, memo)
        server.resources = current
        return resourceTree()
      }
      return record.tree
    }
    /**
     * A layer's files with these extensions that a language set reads: listed, and held by the
     * source (`installedFiles` — CASC names other locales only its CDN holds; reading one would
     * download it) or edited in this view. The held set is kept per layer and extensions.
     */
    const installedSets = new Map<string, Promise<{
      readonly files: readonly string[]; readonly keys: ReadonlySet<string>
    } | undefined>>()
    let installedGeneration = savedGeneration
    /** Reuse the source's exact indexed spellings and membership until saved inputs change. */
    const installedFilesOf = async (layer: Sc2ModContextLayer, extensions: readonly string[]) => {
      if (installedGeneration !== savedGeneration) {
        installedSets.clear()
        installedGeneration = savedGeneration
      }
      const selected = [...new Set(extensions)].sort()
      const key = JSON.stringify([layer.id, selected])
      let installed = installedSets.get(key)
      if (installed === undefined) {
        const storage = options.sources().get(layer.sourceId)
        const pending = (async () => {
          const files = await storage?.installedFiles?.(layer.sourcePath, selected)
          return files === undefined ? undefined : {
            files: Object.freeze([...files]), keys: new Set(files.map(file => file.toLowerCase())),
          }
        })()
        installed = pending
        installedSets.set(key, pending)
        pending.catch(() => { if (installedSets.get(key) === pending) installedSets.delete(key) })
      }
      return installed
    }
    /** Prefer the indexed subset; walking all CASC assets to find scripts is unnecessary. */
    const languageFilesOf = async (layer: Sc2ModContextLayer, extensions: readonly string[]): Promise<readonly string[]> => {
      const held = await installedFilesOf(layer, extensions)
      if (held === undefined) return (await listing(layer.id)).filter(file => extensions.includes(extensionOf(file)))
      const files = held.files.filter(file => extensions.includes(extensionOf(file)))
      const seen = new Set(files.map(file => file.toLowerCase()))
      const vfsPath = vfsPathOf(layer.id)
      for (const overlay of server.overlays.values()) {
        if (overlay.vfsPath === vfsPath && extensions.includes(extensionOf(overlay.path)) && !seen.has(overlay.path.toLowerCase())) {
          files.push(overlay.path)
          seen.add(overlay.path.toLowerCase())
        }
      }
      return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    }
    /** These listed files of a layer that its source holds or this view edits. */
    const heldFilesOf = async (layer: Sc2ModContextLayer, listed: readonly string[]): Promise<readonly string[]> => {
      if (listed.length === 0) return listed
      const held = await installedFilesOf(layer, listed.map(extensionOf))
      if (held === undefined) return listed
      const vfsPath = vfsPathOf(layer.id)
      return listed.filter(file => held.keys.has(file.toLowerCase()) || server.overlays.has(overlayKey(vfsPath, file)))
    }
    /**
     * The chain's cross-language link index with this view's unsaved text, rebuilt at a new revision
     * (`modules/galaxy/language/served-links.js`): the held files of the mixed SC2 languages, by the
     * host's language classifier, in chain order.
     */
    const languageDocumentsAt = async (signal?: AbortSignal) => {
      const classify = options.languageFiles
      if (classify === undefined) throw new TypeError('the host gave no language classifier: cross-language answers are not served')
      const { SERVED_LINK_LANGUAGE_IDS } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
      const wanted = new Set([...SERVED_LINK_LANGUAGE_IDS, 'sc2-style', 'sc2-wizard', 'sc2-bank', 'sc2-bank-list', 'sc2-cutscene', 'storm-cutscene'])
      const held = (server.languageDocuments ??= { revision: -1 })
      while (held.revision !== server.revision) {
        if (held.building === undefined) {
          const revision = server.revision
          const generation = savedGeneration
          held.building = (async () => {
            const saved = chain.languageDocuments
            if (saved !== undefined) await savedLanguages.get(savedChainKey, () => Promise.resolve(saved))
            const savedByKey = new Map(saved?.documents.map(document =>
              [languageInputKey(document.layerId, document.path), document] as const))
            const documents: { layerId: string; path: string; languageId: string; text: string }[] = []
            const dirty = held.dirty
            const previous = dirty === undefined ? undefined : new Map(held.documents?.map(document =>
              [languageInputKey(document.layerId, document.path), document] as const))
            let incomplete = false
            for (const layer of layers) {
              const listed = (await listing(layer.id)).filter(file => wanted.has(classify(file).languageId ?? ''))
              for (const file of await heldFilesOf(layer, listed)) {
                try {
                  const key = languageInputKey(layer.id, file)
                  const languageId = classify(file).languageId!
                  const kept = previous?.get(key)
                  const base = savedByKey.get(key)
                  const overlay = server.overlays.get(overlayKey(vfsPathOf(layer.id), file))
                  const document = kept !== undefined && kept.path === file && kept.languageId === languageId && !dirty!.has(key)
                    ? kept : base !== undefined && base.path === file && base.languageId === languageId && overlay === undefined
                      ? base : { layerId: layer.id, path: file, languageId,
                        text: galaxyDecoder.decode(await readFile(layer.id, file, MAXIMUM_GALAXY_BYTES)) }
                  documents.push(base !== undefined && base.path === document.path && base.languageId === languageId &&
                    base.text === document.text ? base : document)
                } catch {
                  // A missing input must never authorize a complete rename or verification.
                  incomplete = true
                }
              }
            }
            // didOpen also sends saved text as an overlay. Admit it only after comparing the
            // native saved bytes; a new/modified/failed input must remain private to its session.
            let native = !incomplete
            for (const document of documents) {
              if (!native) break
              if (!server.overlays.has(overlayKey(vfsPathOf(document.layerId), document.path))) continue
              const base = savedByKey.get(languageInputKey(document.layerId, document.path))
              if (base !== undefined) {
                native = base.path === document.path && base.languageId === document.languageId && base.text === document.text
                continue
              }
              try {
                const bytes = await savedReader.read(document.layerId, document.path, MAXIMUM_GALAXY_BYTES)
                native = matchesSavedText(document.text, bytes)
              } catch { native = false }
            }
            if (server.revision === revision && savedGeneration === generation) {
              // Only the exact same ordered inputs and completeness may keep derived indexes.
              const unchanged = dirty !== undefined && incomplete === held.incomplete &&
                documents.length === held.documents?.length && documents.every((document, index) => document === held.documents![index])
              if (!unchanged) {
                held.documents = documents
                delete held.links
                delete held.dataDocuments
                delete held.strings
              }
              held.dirty = new Set()
              held.incomplete = incomplete
              held.revision = revision
              if (native) {
                const current = chain.languageDocuments
                const same = current !== undefined && current.incomplete === incomplete &&
                  current.documents.length === documents.length && documents.every((document, index) => {
                    const prior = current.documents[index]!
                    return document.layerId === prior.layerId && document.path === prior.path &&
                      document.languageId === prior.languageId && document.text === prior.text
                  })
                if (!same && current !== undefined) savedLanguages.deletePrefix(savedChainKey)
                const retained = same ? current : { documents: Object.freeze(documents.map(document => Object.freeze(document))), incomplete }
                chain.languageDocuments = retained
                await savedLanguages.get(savedChainKey, () => Promise.resolve(retained), () => {
                  if (chain.languageDocuments === retained) delete chain.languageDocuments
                })
                held.documents = retained.documents
                if (retained.links !== undefined) held.links = retained.links
                if (retained.dataDocuments !== undefined) held.dataDocuments = retained.dataDocuments
              }
            }
          })().finally(() => { held.building = undefined })
        }
        await held.building
        signal?.throwIfAborted()
      }
      return held
    }
    /**
     * The chain's mixed-language documents in chain order. Past the index's link bound the opened
     * package's documents are not indexed, but a usage question still reads them
     * (`sc2-workspace-links.js` `literalUsagesOf`); moving them first would index them for
     * diagnostics, where the snapshot does not.
     */
    const mixedDocumentsOf = async (held: Awaited<ReturnType<typeof languageDocumentsAt>>) => {
      const { SERVED_LINK_LANGUAGE_IDS } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
      const mixed = new Set(SERVED_LINK_LANGUAGE_IDS)
      return held.documents!.filter(document => mixed.has(document.languageId))
    }
    /** The link index over the chain's mixed-language documents (`served-links.js`), per revision. */
    const linksAt = async (signal?: AbortSignal): Promise<ServedLinkIndex> => {
      const held = await languageDocumentsAt(signal)
      if (held.links === undefined) {
        const { createServedLinkIndex } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
        held.links = createServedLinkIndex(await mixedDocumentsOf(held), held.incomplete === true || resolved.unresolved.length > 0)
        const saved = chain.languageDocuments
        if (saved !== undefined && saved.documents === held.documents) saved.links = held.links
      }
      return held.links
    }
    /**
     * `data.references`: a Data references request over the chain (`language-answer.ts`
     * `servedDataReferences`): the cross-language link index and the Data catalogs, per revision.
     */
    const dataReferences = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const { servedDataReferences } = await import('./language-answer.js')
      const question = request as {
        readonly document?: { readonly layerId?: unknown; readonly path?: unknown }
        readonly offset?: unknown
        readonly includeDeclaration?: unknown
        readonly maxResults?: unknown
        readonly incomplete?: unknown
      }
      const layerId = question.document?.layerId
      const filePath = question.document?.path
      if (typeof layerId !== 'string' || typeof filePath !== 'string' || typeof question.offset !== 'number' ||
          !Number.isSafeInteger(question.offset) || typeof question.includeDeclaration !== 'boolean' ||
          typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) || question.maxResults < 1 ||
          question.maxResults > 65_536 || typeof question.incomplete !== 'boolean') {
        throw new TypeError('data.references needs a document, an offset, includeDeclaration, maxResults and incomplete')
      }
      vfsPathOf(layerId)
      const links = await linksAt(signal)
      const held = await languageDocumentsAt(signal)
      if (held.dataDocuments === undefined) {
        // Preserve object identity for the reference owner's weak parse cache across unrelated edits.
        const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
        const views = (held.dataDocumentViews ??= new WeakMap<object, ServedDataDocument>())
        held.dataDocuments = (await mixedDocumentsOf(held)).map(document => {
          let view = views.get(document)
          if (view === undefined) {
            view = Object.freeze({ layerId: document.layerId, path: document.path, languageId: document.languageId,
              text: document.text, linkUri: servedLinkUri(document.layerId, document.path) })
            views.set(document, view)
          }
          return view
        })
        const saved = chain.languageDocuments
        if (saved !== undefined && saved.documents === held.documents) saved.dataDocuments = held.dataDocuments
      }
      const answer = servedDataReferences({
        documents: held.dataDocuments,
        primary: { layerId, path: filePath },
        offset: question.offset,
        includeDeclaration: question.includeDeclaration,
        maxResults: question.maxResults,
        incomplete: question.incomplete || resolved.unresolved.length > 0,
        links,
      })
      return Object.freeze({
        revision: String(server.revision),
        ...(answer ?? { documents: [], locations: [], isIncomplete: true }),
      })
    }
    /**
     * `strings.diagnostics`: a catalog's markup checked against the chain's catalogs, sheets and Data
     * (`modules/strings/providers/language/src/served-diagnostics.ts`), per revision.
     */
    const stringsDiagnostics = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as {
        readonly kind?: string
        readonly position?: { readonly line?: unknown; readonly character?: unknown }
        readonly document?: { readonly layerId?: unknown; readonly path?: unknown }
        readonly uri?: unknown
        readonly maxResults?: unknown
        readonly incomplete?: unknown
      }
      const layerId = question.document?.layerId
      const filePath = question.document?.path
      if (typeof layerId !== 'string' || typeof filePath !== 'string' || typeof question.uri !== 'string' ||
          typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) || question.maxResults < 1 ||
          question.maxResults > 65_536 || typeof question.incomplete !== 'boolean') {
        throw new TypeError('strings.diagnostics needs a document, its URI, maxResults and incomplete')
      }
      vfsPathOf(layerId)
      const held = await languageDocumentsAt(signal)
      if (held.strings === undefined) {
        const { createStringsServedDiagnostics } = await import('@modkit/blizzard-starcraft2/strings/served-diagnostics')
        const checker = createStringsServedDiagnostics()
        checker.update(held.documents!.filter(document =>
          document.languageId === 'sc2-strings' || document.languageId === 'sc2-style' || document.languageId === 'sc2-data'))
        held.strings = checker
      }
      if (question.kind === 'strings.hover') {
        const line = question.position?.line
        const character = question.position?.character
        if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 ||
            typeof character !== 'number' || !Number.isSafeInteger(character) || character < 0) {
          throw new TypeError('strings.hover needs a valid UTF-16 position')
        }
        const hover = held.strings.hover(layerId, filePath, question.uri, { line, character })
        return Object.freeze({ revision: String(server.revision), ...(hover === undefined ? {} : { hover }) })
      }
      const answer = held.strings.diagnostics(layerId, filePath, question.uri, {
        maxResults: question.maxResults, incomplete: question.incomplete,
      })
      return Object.freeze({
        revision: String(server.revision),
        ...(answer === undefined ? { incomplete: true, diagnostics: { diagnostics: [], isIncomplete: true } } : { diagnostics: answer }),
      })
    }
    /**
     * `galaxy.references`: one retained Galaxy index over the chain's scripts with this view's unsaved
     * text, re-analysing only changed files at a new revision. The language provider asks it instead
     * of carrying every script of the chain in a request (`modules/galaxy/language/served-references.js`).
     */
    const galaxyIndexAt = async (keep: string, signal?: AbortSignal): Promise<GalaxyServedReferenceIndex> => {
      const { createGalaxyServedReferences } = await import('@modkit/blizzard-starcraft2/galaxy/served-references')
      const held = (server.galaxy ??= { index: createGalaxyServedReferences(), revision: -1 })
      // A carried revision must preserve the old rebuild's exemption for a newly requested script.
      while (held.revision !== server.revision || (held.carried === true && held.keep !== keep)) {
        if (held.building === undefined) {
          const revision = server.revision
          held.building = (async () => {
            const documents: { layerId: string; path: string; text: string }[] = []
            for (const layer of layers) {
              for (const filePath of await languageFilesOf(layer, ['galaxy'])) {
                try {
                  documents.push({ layerId: layer.id, path: filePath, text: galaxyDecoder.decode(await readFile(layer.id, filePath, MAXIMUM_GALAXY_BYTES)) })
                } catch {
                  // Unreadable or not UTF-8: left out, as the snapshot path leaves it out.
                }
              }
            }
            if (server.revision === revision) {
              held.index.update(documents, keep)
              held.revision = revision
              held.keep = keep
              held.carried = false
            }
          })().finally(() => { held.building = undefined })
        }
        await held.building
        signal?.throwIfAborted()
      }
      return held.index
    }
    /**
     * A positioned Galaxy question about one document of the chain: `galaxy.references`
     * (`includeDeclaration`), `galaxy.hover`, `galaxy.signature-help` and `galaxy.definition`
     * (`uri`, the name the editor gives the document, which hover and signature text carry).
     */
    const galaxyQuestion = async (kind: string, request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as {
        readonly document?: { readonly layerId?: unknown; readonly path?: unknown }
        readonly offset?: unknown
        readonly includeDeclaration?: unknown
        readonly uri?: unknown
        readonly maxResults?: unknown
        readonly functionExpand?: unknown
        readonly incomplete?: unknown
      }
      const layerId = question.document?.layerId
      const filePath = question.document?.path
      const offset = question.offset
      const references = kind === 'galaxy.references'
      if (typeof layerId !== 'string' || typeof filePath !== 'string' || typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          (references
            ? question.includeDeclaration !== undefined && typeof question.includeDeclaration !== 'boolean'
            : typeof question.uri !== 'string')) {
        throw new TypeError(`${kind} needs a document, an offset and ${references ? 'an optional includeDeclaration' : 'the document URI'}`)
      }
      if (kind === 'galaxy.completion' && (typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) ||
          question.maxResults < 1 || question.maxResults > 65_536 ||
          (question.functionExpand !== undefined && typeof question.functionExpand !== 'string'))) {
        throw new TypeError('galaxy.completion needs maxResults and an optional functionExpand')
      }
      if (kind === 'galaxy.diagnostics' && (typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) ||
          question.maxResults < 1 || question.maxResults > 65_536 || typeof question.incomplete !== 'boolean')) {
        throw new TypeError('galaxy.diagnostics needs maxResults and incomplete')
      }
      vfsPathOf(layerId)
      const index = await galaxyIndexAt(`${layerId}\u0000${filePath}`, signal)
      const revision = String(server.revision)
      const uri = question.uri as string
      if (references) {
        const answer = index.references(layerId, filePath, offset, question.includeDeclaration === true)
        return Object.freeze({
          revision,
          ...(answer ?? { incomplete: true, documents: Object.freeze([]), references: Object.freeze([]) }),
        })
      }
      if (kind === 'galaxy.definition') {
        const answer = index.definition(layerId, filePath, offset, uri)
        return Object.freeze({
          revision,
          ...(answer ?? { incomplete: true, semantic: true, documents: Object.freeze([]), definitions: Object.freeze([]) }),
        })
      }
      if (kind === 'galaxy.diagnostics') {
        const links = await linksAt(signal)
        const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
        const answer = index.diagnostics(layerId, filePath, uri, links, servedLinkUri(layerId, filePath), {
          maxResults: question.maxResults as number,
          incomplete: question.incomplete as boolean,
        })
        return Object.freeze({ revision: String(server.revision),
          ...(answer ?? { incomplete: true, diagnostics: { diagnostics: [], isIncomplete: true } }) })
      }
      if (kind === 'galaxy.completion') {
        const answer = index.completion(layerId, filePath, offset, uri, {
          maxResults: question.maxResults as number,
          ...(question.functionExpand === undefined ? {} : { functionExpand: question.functionExpand as string }),
        })
        return Object.freeze({ revision, ...(answer ?? { incomplete: true, completion: { items: [], isIncomplete: true } }) })
      }
      const answer = kind === 'galaxy.hover'
        ? index.hover(layerId, filePath, offset, uri)
        : index.signatureHelp(layerId, filePath, offset, uri)
      return Object.freeze({ revision, ...(answer ?? { incomplete: true }) })
    }
    /**
     * `style.definition`: every declaration of a Style, Constant or FontGroup across the chain's
     * sheets with this view's unsaved text, from one retained set re-read at a new revision
     * (`modules/style/providers/language/src/served-definitions.ts`).
     */
    const styleDefinition = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as { readonly styleKind?: unknown; readonly name?: unknown }
      if ((question.styleKind !== 'style' && question.styleKind !== 'constant' && question.styleKind !== 'font-group') ||
          typeof question.name !== 'string' || question.name === '' || question.name.length > 1024) {
        throw new TypeError('style.definition needs a style kind and a name')
      }
      const { createStyleServedDefinitions } = await import('@modkit/blizzard-starcraft2/style/served-definitions')
      const held = (server.styles ??= { sheets: createStyleServedDefinitions(), revision: -1 })
      while (held.revision !== server.revision) {
        if (held.building === undefined) {
          const revision = server.revision
          held.building = (async () => {
            const sheets: { layerId: string; path: string; text: string }[] = []
            for (const layer of layers) {
              for (const filePath of await languageFilesOf(layer, styleInputs)) {
                try {
                  sheets.push({ layerId: layer.id, path: filePath, text: galaxyDecoder.decode(await readFile(layer.id, filePath, MAXIMUM_GALAXY_BYTES)) })
                } catch {
                  // Unreadable or not UTF-8: left out, as the snapshot path leaves it out.
                }
              }
            }
            if (server.revision === revision) {
              held.sheets.update(sheets)
              held.revision = revision
            }
          })().finally(() => { held.building = undefined })
        }
        await held.building
        signal?.throwIfAborted()
      }
      return Object.freeze({ revision: String(server.revision), ...held.sheets.definitions(question.styleKind, question.name) })
    }
    /** Style usages across the retained sheets, catalogs and layouts, without a client snapshot. */
    const styleReferences = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as { readonly document?: { readonly layerId?: unknown; readonly path?: unknown };
        readonly position?: { readonly line?: unknown; readonly character?: unknown };
        readonly includeDeclaration?: unknown; readonly maxResults?: unknown; readonly incomplete?: unknown }
      const layerId = question.document?.layerId, filePath = question.document?.path
      const line = question.position?.line, character = question.position?.character
      if (typeof layerId !== 'string' || typeof filePath !== 'string' || typeof line !== 'number' ||
          !Number.isSafeInteger(line) || line < 0 || typeof character !== 'number' || !Number.isSafeInteger(character) || character < 0 ||
          typeof question.includeDeclaration !== 'boolean' || typeof question.maxResults !== 'number' ||
          !Number.isSafeInteger(question.maxResults) || question.maxResults < 1 || question.maxResults > 65_536 ||
          typeof question.incomplete !== 'boolean') throw new TypeError('style.references needs a document, position and bounded options')
      vfsPathOf(layerId)
      const documents = await languageDocumentsAt(signal)
      const { createStyleServedDefinitions } = await import('@modkit/blizzard-starcraft2/style/served-definitions')
      const held = (server.styles ??= { sheets: createStyleServedDefinitions(), revision: -1 })
      held.sheets.updateUsers(documents.documents!)
      return Object.freeze({ revision: String(server.revision), ...held.sheets.references(layerId, filePath, { line, character }, {
        includeDeclaration: question.includeDeclaration, maxResults: question.maxResults,
        incomplete: question.incomplete || resolved.unresolved.length > 0,
      }) })
    }
    /** Reuse the Data language owner and immutable request identities at the held revision. */
    const languageOwnerAt = async (held: Awaited<ReturnType<typeof languageDocumentsAt>>) => {
      const { createServedLanguageOwner } = await import('@modkit/blizzard-starcraft2/mod/served-language-owner')
      const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
      const renames = (server.languageOwner ??= createServedLanguageOwner(async (dataRequest, dataSignal) => {
        const answer = await context.query(dataRequest, dataSignal) as { readonly documents: readonly { readonly layerId: string; readonly path: string }[] }
        return { ...answer, documents: answer.documents.map(document => ({ ...document, uri: servedLinkUri(document.layerId, document.path) })) }
      }))
      renames.update(held.documents!, layers, String(server.revision))
      return renames
    }
    /** The existing listing authority supplies a bounded path index only when Data needs file paths. */
    const languageAssetsAt = async (signal?: AbortSignal) => {
      while (server.languageAssets?.revision !== server.revision) {
        const revision = server.revision
        const byPath = new Map<string, { path: string; owner: number }>()
        let characters = 0, incomplete = false, visited = 0
        for (const [owner, layer] of layers.entries()) {
          for (const file of await listing(layer.id)) {
            const key = file.toLowerCase(), existing = byPath.get(key)
            if (existing === undefined && (byPath.size >= 1_048_576 || characters + file.length > 32 * 1024 * 1024)) incomplete = true
            else { if (existing === undefined) characters += file.length; byPath.set(key, { path: file, owner }) }
            if (++visited % 4096 === 0) { signal?.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)) }
          }
        }
        const rows = [...byPath.values()], paths = rows.map(row => row.path), owners = rows.map(row => row.owner)
        const inputs: readonly LanguageWorkspaceSemanticInput[] = [{ kind: 'dependency-closure', id: 'served-assets', revision: String(revision),
          payload: { layers: layers.map(layer => ({ layerId: layer.id, sourceId: layer.sourceId, sourcePath: layer.sourcePath })) } },
        { kind: 'content-path-index', id: 'served-assets/paths', revision: String(revision),
          payload: { schemaVersion: 1, isComplete: !incomplete, paths, layers: owners } }]
        signal?.throwIfAborted()
        if (server.revision === revision) server.languageAssets = { revision, inputs, paths, owners, incomplete }
      }
      return server.languageAssets
    }
    /** Remaining semantic surfaces reuse held request identities and canonical language owners. */
    const languageFeatureQuestion = async (request: unknown, signal?: AbortSignal) => {
      const q = request as ServedFeatureQuestion
      if (q?.semanticInputs !== undefined && (!Array.isArray(q.semanticInputs) || q.semanticInputs.length > 8 ||
          q.semanticInputs.some(input => input?.kind !== 'locale-set') || JSON.stringify(q.semanticInputs).length > 16_384)) throw new TypeError('language.feature locale inputs exceed bounds')
      if (typeof q?.document?.layerId !== 'string' || typeof q.document.path !== 'string' ||
          typeof q.feature !== 'string' || !Number.isSafeInteger(q.maxResults) || q.maxResults < 1 || q.maxResults > 65_536 ||
          !Number.isSafeInteger(q.maxDocuments) || q.maxDocuments < 1 || q.maxDocuments > 4096 || typeof q.incomplete !== 'boolean' ||
          q.parameters === null || typeof q.parameters !== 'object' || Array.isArray(q.parameters) ||
          Object.keys(q.parameters).some(key => !['position', 'range', 'diagnostics', 'query', 'color', 'maxEdits', 'newName', 'includeDeclaration'].includes(key)))
        throw new TypeError('language.feature needs a document, supported surface and bounded parameters')
      if (q.parameters['query'] !== undefined && (typeof q.parameters['query'] !== 'string' || q.parameters['query'].length > 512)) throw new TypeError('symbol query exceeds bounds')
      if (q.parameters['diagnostics'] !== undefined && (!Array.isArray(q.parameters['diagnostics']) || q.parameters['diagnostics'].length > q.maxResults)) throw new TypeError('diagnostic input exceeds bounds')
      const held = await languageDocumentsAt(signal)
      const primary = held.documents!.find(document => document.layerId === q.document.layerId && document.path === q.document.path)
      if (primary === undefined) return { revision: String(server.revision), hasValue: false, documents: [], identities: [] }
      const allowed: Readonly<Record<string, readonly string[]>> = {
        'sc2-data': ['workspaceSymbols', 'codeLenses', 'codeActions', 'completion', 'definition'],
        galaxy: ['workspaceSymbols'], 'sc2-layout': ['workspaceSymbols'],
        'sc2-strings': ['workspaceSymbols', 'completion', 'documentColors', 'definition'],
        'sc2-style': ['workspaceSymbols', 'completion', 'hover', 'definition', 'diagnostics'],
        'sc2-wizard': ['workspaceSymbols', 'completion', 'hover', 'definition', 'references', 'diagnostics'],
        'sc2-triggers': ['workspaceSymbols', 'documentSymbols', 'completion', 'hover', 'signatureHelp', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'sc2-map-objects': ['hover', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'sc2-map-preload': ['hover', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'sc2-bank': ['completion', 'hover', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'sc2-bank-list': ['completion', 'hover', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'sc2-cutscene': ['workspaceSymbols', 'completion', 'hover', 'signatureHelp', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
        'storm-cutscene': ['workspaceSymbols', 'completion', 'hover', 'signatureHelp', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'],
      }
      if (!allowed[primary.languageId]?.includes(q.feature)) throw new TypeError('language.feature is not supported for this document language')
      const owner = await languageOwnerAt(held)
      const question = { ...q, incomplete: q.incomplete || held.incomplete === true || resolved.unresolved.length > 0 }
      if (await owner.needsContentPaths(question, signal)) {
        const assets = await languageAssetsAt(signal)
        owner.contentPaths(assets.inputs, layers, assets.paths, assets.owners, assets.incomplete)
      }
      let value: unknown
      if (primary.languageId === 'galaxy') {
        const index = await galaxyIndexAt(`${q.document.layerId}\u0000${q.document.path}`, signal)
        value = index.workspaceSymbols(q.document.layerId, q.document.path, q.parameters['query'] as string, q.maxResults, question.incomplete)
      } else if (primary.languageId === 'sc2-layout') {
        await layoutQuestion('layout.completion', { document: q.document, offset: 0, maxResults: 1 }, signal)
        value = server.layouts!.index.workspaceSymbols(q.document.layerId, q.document.path, q.parameters['query'] as string, q.maxResults, question.incomplete)
      } else value = await owner.feature(question, signal,
        ['sc2-triggers', 'sc2-map-objects', 'sc2-map-preload'].includes(primary.languageId) ? await linksAt(signal) : undefined)
      signal?.throwIfAborted()
      if (value !== null && typeof value === 'object' && 'isIncomplete' in value) value = { ...value, isIncomplete: value.isIncomplete || question.incomplete }
      return { revision: String(server.revision), ...owner.project(value) }
    }
    /** Plan through the retained language owners; Host validates only the resulting write targets. */
    const renameQuestion = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const prepare = (request as { readonly kind?: unknown } | null)?.kind === 'language.prepare-rename'
      const q = prepare ? { ...(request as Partial<ServedRenameQuestion>), newName: '_prepared', maxEdits: 1 } : request as Partial<ServedRenameQuestion>
      if (typeof q.document?.layerId !== 'string' || typeof q.document.path !== 'string' ||
          typeof q.position?.line !== 'number' || !Number.isSafeInteger(q.position.line) || q.position.line < 0 ||
          typeof q.position.character !== 'number' || !Number.isSafeInteger(q.position.character) || q.position.character < 0 ||
          typeof q.newName !== 'string' || q.newName.length < 1 || q.newName.length > 256 || /[\u0000-\u001f\u007f]/u.test(q.newName) ||
          typeof q.maxEdits !== 'number' || !Number.isSafeInteger(q.maxEdits) || q.maxEdits < 1 || q.maxEdits > 65_536 ||
          typeof q.maxResults !== 'number' || !Number.isSafeInteger(q.maxResults) || q.maxResults < 1 || q.maxResults > 65_536 ||
          typeof q.maxDocuments !== 'number' || !Number.isSafeInteger(q.maxDocuments) || q.maxDocuments < 1 || q.maxDocuments > 4096 ||
          typeof q.incomplete !== 'boolean') throw new TypeError('language.rename needs a document, position, name and bounded options')
      const question = q as ServedRenameQuestion
      const held = await languageDocumentsAt(signal)
      const primary = held.documents!.find(document => document.layerId === question.document.layerId && document.path === question.document.path)
      if (primary === undefined) return { revision: String(server.revision), documents: [], edit: null }
      const starts = lineStartOffsets(primary.text)
      const start = starts[question.position.line]
      const end = starts[question.position.line + 1] === undefined ? primary.text.length : starts[question.position.line + 1]! - 1
      if (start === undefined || question.position.character > end - start) throw new RangeError('rename position is outside its document')
      const offset = start + question.position.character
      const renames = await languageOwnerAt(held)
      const result = await renames[prepare ? 'prepare' : 'rename']({ ...question, incomplete: question.incomplete || held.incomplete === true || resolved.unresolved.length > 0 }, await linksAt(signal),
        async (_question, feature, byUri, editable, links) => {
          const index = await galaxyIndexAt(`${question.document.layerId}\u0000${question.document.path}`, signal)
          return index[prepare ? 'prepareRename' : 'rename'](question.document.layerId, question.document.path, offset, feature, byUri, editable, links)
        },
        async (_question, feature) => {
          // Ensure the existing layout index is current; do not create another workspace.
          await layoutQuestion('layout.definition', { document: question.document, offset }, signal)
          return prepare ? server.layouts!.index.prepareRename(question.document.layerId, question.document.path, offset)
            : server.layouts!.index.rename(question.document.layerId, question.document.path, offset, feature)
        }, signal)
      signal?.throwIfAborted()
      return { revision: String(server.revision), ...(prepare ? result === undefined ? {} : { preparation: result } : result as object) }
    }
    /** Verify all supported language documents of the opened mod using the retained owners. */
    const verifyQuestion = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const q = request as { readonly maxResults?: unknown; readonly maxDocuments?: unknown; readonly incomplete?: unknown }
      if (typeof q.maxResults !== 'number' || !Number.isSafeInteger(q.maxResults) || q.maxResults < 1 || q.maxResults > 65_536 ||
          typeof q.maxDocuments !== 'number' || !Number.isSafeInteger(q.maxDocuments) || q.maxDocuments < 1 || q.maxDocuments > 4096 ||
          typeof q.incomplete !== 'boolean') throw new TypeError('language.verify needs bounded limits and completeness')
      const held = await languageDocumentsAt(signal)
      const primaryLayers = new Set(layers.filter(layer => layer.role === 'primary' || layer.sourceId === HOST_SOURCE_ID).map(layer => layer.id))
      const documents = held.documents!.filter(document => primaryLayers.has(document.layerId) &&
        ['sc2-data', 'galaxy', 'sc2-layout', 'sc2-strings', 'sc2-style', 'sc2-wizard', 'sc2-triggers',
          'sc2-map-objects', 'sc2-map-preload', 'sc2-bank', 'sc2-bank-list', 'sc2-cutscene', 'storm-cutscene'].includes(document.languageId))
      const { createSc2StyleLanguageProvider } = await import('@modkit/blizzard-starcraft2/style/language')
      const { createSc2WizardLanguageProvider } = await import('@modkit/blizzard-starcraft2/wizard/language')
      const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
      let totalCharacters = 0
      const bounded = held.documents!.filter(document => {
        if (document.text.length > 64 * 1024 * 1024 || totalCharacters + document.text.length > 128 * 1024 * 1024) return false
        totalCharacters += document.text.length
        return true
      }).slice(0, 4096)
      const featureDocuments = bounded.map(document => ({ uri: servedLinkUri(document.layerId, document.path),
        languageId: document.languageId, version: 0, text: document.text }))
      const reports: { readonly layerId: string; readonly path: string; readonly diagnostics: readonly unknown[] }[] = []
      const inputIncomplete = q.incomplete || held.incomplete === true || bounded.length < held.documents!.length || resolved.unresolved.length > 0
      let isIncomplete = inputIncomplete || documents.length > q.maxDocuments
      let count = 0
      for (const document of documents.slice(0, q.maxDocuments)) {
        signal?.throwIfAborted()
        const maximum = q.maxResults - count
        if (maximum < 1) { isIncomplete = true; break }
        const place = { layerId: document.layerId, path: document.path }
        const uri = servedLinkUri(place.layerId, place.path)
        let report: { readonly diagnostics: readonly unknown[]; readonly isIncomplete?: boolean }
        if (document.languageId === 'galaxy') {
          const answer = await galaxyQuestion('galaxy.diagnostics', { document: place, offset: 0, uri,
            maxResults: maximum, incomplete: inputIncomplete }, signal) as { diagnostics: typeof report }
          report = answer.diagnostics
        } else if (document.languageId === 'sc2-layout') {
          const answer = await layoutQuestion('layout.diagnostics', { document: place, offset: 0,
            maxResults: maximum, incomplete: inputIncomplete }, signal) as { diagnostics: typeof report }
          report = answer.diagnostics
        } else if (document.languageId === 'sc2-strings') {
          const answer = await stringsDiagnostics({ kind: 'strings.diagnostics', document: place, uri,
            maxResults: maximum, incomplete: inputIncomplete }, signal) as { diagnostics: typeof report }
          report = answer.diagnostics
        } else if (document.languageId === 'sc2-data') {
          const owner = await languageOwnerAt(held)
          report = await owner.dataDiagnostics({ document: place, position: { line: 0, character: 0 },
            newName: '_verify', maxEdits: 1, maxResults: maximum, maxDocuments: q.maxDocuments, incomplete: inputIncomplete }, signal)
        } else if (document.languageId === 'sc2-style' || document.languageId === 'sc2-wizard') {
          const provider = document.languageId === 'sc2-style' ? createSc2StyleLanguageProvider() : createSc2WizardLanguageProvider()
          report = await provider.diagnostics!({ document: { uri, languageId: document.languageId, version: 0, text: document.text },
            workspaceDocuments: featureDocuments, maxResults: maximum, maxDocuments: q.maxDocuments,
            workspaceIncomplete: inputIncomplete, ...(signal === undefined ? {} : { signal }) })
        } else {
          const owner = await languageOwnerAt(held)
          report = await owner.feature({ document: place, feature: 'diagnostics', maxResults: maximum,
            maxDocuments: q.maxDocuments, incomplete: inputIncomplete, parameters: {} }, signal,
            ['sc2-triggers', 'sc2-map-objects', 'sc2-map-preload'].includes(document.languageId) ? await linksAt(signal) : undefined) as typeof report
        }
        count += report.diagnostics.length
        isIncomplete ||= report.isIncomplete === true
        reports.push({ ...place, diagnostics: report.diagnostics })
        // Cancellation and requests of other languages must get an event-loop turn between files.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return { revision: String(server.revision), documents: reports, isIncomplete }
    }
    /**
     * `layout.definition` and `layout.hover` at an offset of a layout: the declaration a reference
     * leads to (template, include, constant, frame) and the hover, from one layout workspace over the
     * chain's layouts and sheets with this view's unsaved text, rebuilt at a new revision
     * (`modules/layout/providers/language/served-definitions.js`).
     */
    const layoutQuestion = async (kind: string, request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as {
        readonly document?: { readonly layerId?: unknown; readonly path?: unknown }
        readonly offset?: unknown
        readonly maxResults?: unknown
        readonly incomplete?: unknown
        readonly includeDeclaration?: unknown
      }
      const layerId = question.document?.layerId
      const filePath = question.document?.path
      const offset = question.offset
      if (typeof layerId !== 'string' || typeof filePath !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) ||
          ((kind === 'layout.completion' || kind === 'layout.diagnostics') && (typeof question.maxResults !== 'number' ||
            !Number.isSafeInteger(question.maxResults) || question.maxResults < 1 || question.maxResults > 65_536)) ||
          (kind === 'layout.diagnostics' && typeof question.incomplete !== 'boolean')) {
        throw new TypeError(`${kind} needs a document and an offset${kind === 'layout.completion' ? ' and maxResults'
          : kind === 'layout.diagnostics' ? ', maxResults and incomplete' : ''}`)
      }
      vfsPathOf(layerId)
      const { createLayoutServedDefinitions } = await import('@modkit/blizzard-starcraft2/layout/served-definitions')
      const held = (server.layouts ??= { index: createLayoutServedDefinitions(), revision: -1 })
      const keep = `${layerId}\u0000${filePath}`
      // Preserve the requested layout's budget exemption when carrying an older workspace forward.
      while (held.revision !== server.revision || (held.carried === true && held.keep !== keep)) {
        if (held.building === undefined) {
          const revision = server.revision
          held.building = (async () => {
            const documents: { layerId: string; path: string; text: string }[] = []
            for (const layer of layers) {
              for (const file of await languageFilesOf(layer, layoutInputs)) {
                try {
                  documents.push({ layerId: layer.id, path: file, text: galaxyDecoder.decode(await readFile(layer.id, file, MAXIMUM_GALAXY_BYTES)) })
                } catch {
                  // Unreadable or not UTF-8: left out, as the snapshot path leaves it out.
                }
              }
            }
            if (server.revision === revision) {
              await held.index.update(documents, { layerId, path: filePath })
              held.revision = revision
              held.keep = keep
              held.carried = false
            }
          })().finally(() => { held.building = undefined })
        }
        await held.building
        signal?.throwIfAborted()
      }
      const revision = String(server.revision)
      const crossFeature = kind === 'layout.hover' || kind === 'layout.definition' || kind === 'layout.references'
      const links = crossFeature && options.languageFiles !== undefined ? await linksAt(signal) : undefined
      const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
      const linkUri = servedLinkUri(layerId, filePath)
      /** Project existing owner URI keys to layer/path identities; Host supplies editor URIs. */
      const projectLocations = async (locations: readonly { readonly uri: string; readonly range: unknown }[]) => {
        const documents = await languageDocumentsAt(signal)
        const names = new Map(documents.documents!.flatMap(document => [
          [servedLinkUri(document.layerId, document.path), document],
          [`modkit-served-layout://${encodeURIComponent(document.layerId)}/${document.path}`, document],
        ] as const))
        const named: { layerId: string; path: string }[] = [], indices = new Map<string, number>()
        const projected = locations.map(location => {
          const place = names.get(location.uri)
          if (place === undefined) throw new TypeError('layout navigation named a document outside its retained chain')
          let document = indices.get(location.uri)
          if (document === undefined) { document = named.push({ layerId: place.layerId, path: place.path }) - 1; indices.set(location.uri, document) }
          return { document, range: location.range }
        })
        return { documents: named, locations: projected }
      }
      if (kind === 'layout.references') {
        if (typeof question.includeDeclaration !== 'boolean' || typeof question.incomplete !== 'boolean' ||
            typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) || question.maxResults < 1 || question.maxResults > 65_536)
          throw new TypeError('layout.references needs bounded options')
        const result = held.index.references(layerId, filePath, offset, links!, linkUri, { maxResults: question.maxResults,
          includeDeclaration: question.includeDeclaration, workspaceIncomplete: question.incomplete })
        const projected = await projectLocations(result?.locations ?? [])
        return { revision: String(server.revision), documents: projected.documents, references: projected.locations,
          incomplete: result?.isIncomplete ?? true }
      }
      if (kind === 'layout.hover') {
        const hover = links?.hoverAt(linkUri, offset)
        if (hover !== undefined) {
          const { entityCommands } = await import('@modkit/blizzard-starcraft2/layout/served-definitions')
          const definition = links!.definitionAt(linkUri, offset)
          const target = links!.targetAt(linkUri, offset)
          const reference = links!.references.find(item => item.uri === linkUri && item.start <= offset && offset <= item.end)
          const text = (await languageDocumentsAt(signal)).documents!.find(document => document.layerId === layerId && document.path === filePath)!.text
          const starts = lineStartOffsets(text)
          return { revision: String(server.revision), ...(definition === undefined ? {} : {
            documents: (await projectLocations([definition])).documents, declarationUri: definition.uri,
          }), hover: { ...hover, ...(reference === undefined ? {} : { range: { start: positionAt(starts, reference.start), end: positionAt(starts, reference.end) } }),
            ...(target === undefined ? {} : { commands: entityCommands(target) }) } }
        }
        return Object.freeze({ revision, ...(held.index.hover(layerId, filePath, offset) ?? { incomplete: true }) })
      }
      if (kind === 'layout.diagnostics') {
        const links = await linksAt(signal)
        const { servedLinkUri } = await import('@modkit/blizzard-starcraft2/galaxy/served-links')
        return Object.freeze({
          revision: String(server.revision),
          ...(held.index.diagnostics(layerId, filePath, links, servedLinkUri(layerId, filePath), {
            maxResults: question.maxResults as number,
            incomplete: question.incomplete as boolean,
          }) ?? { incomplete: true, diagnostics: { diagnostics: [], isIncomplete: true } }),
        })
      }
      if (kind === 'layout.completion') {
        return Object.freeze({
          revision,
          ...(held.index.completion(layerId, filePath, offset, question.maxResults as number) ??
            { incomplete: true, capped: false, items: Object.freeze([]) }),
        })
      }
      let answer = held.index.definition(layerId, filePath, offset)
      if (answer?.definitions.length === 0) {
        const location = links?.definitionAt(linkUri, offset)
        if (location !== undefined) {
          const projected = await projectLocations([location])
          answer = { documents: projected.documents, definitions: projected.locations as typeof answer.definitions, incomplete: links!.isIncomplete }
        }
      }
      return Object.freeze({
        revision,
        ...(answer ?? { incomplete: true, documents: Object.freeze([]), definitions: Object.freeze([]) }),
      })
    }
    /**
     * `strings.keys`: a GameStrings key's definitions and uses (`locations`, `definitions`/`uses`) or
     * the number of other catalogs defining it (`count`), over the chain's catalogs and layouts with
     * this view's unsaved text, re-read at a new revision
     * (`modules/strings/providers/language/src/served-keys.ts`).
     */
    const stringKeysQuestion = async (request: unknown, signal?: AbortSignal): Promise<unknown> => {
      const question = request as {
        readonly action?: unknown
        readonly key?: unknown
        readonly document?: { readonly layerId?: unknown; readonly path?: unknown }
        readonly definitions?: unknown
        readonly uses?: unknown
        readonly maxResults?: unknown
      }
      const layerId = question.document?.layerId
      const filePath = question.document?.path
      if ((question.action !== 'locations' && question.action !== 'count') || typeof question.key !== 'string' ||
          question.key === '' || question.key.length > 1024 || typeof layerId !== 'string' || typeof filePath !== 'string' ||
          (question.action === 'locations' && (typeof question.definitions !== 'boolean' || typeof question.uses !== 'boolean' ||
            typeof question.maxResults !== 'number' || !Number.isSafeInteger(question.maxResults) || question.maxResults < 1))) {
        throw new TypeError('strings.keys needs an action, a key, a document and, for locations, definitions, uses and maxResults')
      }
      vfsPathOf(layerId)
      const { createStringsServedKeys } = await import('@modkit/blizzard-starcraft2/strings/served-keys')
      const held = (server.stringKeys ??= { keys: createStringsServedKeys(), revision: -1 })
      while (held.revision !== server.revision) {
        if (held.building === undefined) {
          const revision = server.revision
          held.building = (async () => {
            const documents: { layerId: string; path: string; text: string }[] = []
            for (const layer of layers) {
              for (const file of await languageFilesOf(layer, ['txt', 'sc2layout', 'galaxy'])) {
                try {
                  documents.push({ layerId: layer.id, path: file, text: galaxyDecoder.decode(await readFile(layer.id, file, MAXIMUM_GALAXY_BYTES)) })
                } catch {
                  // Unreadable or not UTF-8: left out, as the snapshot path leaves it out.
                }
              }
            }
            if (server.revision === revision) {
              held.keys.update(documents)
              held.revision = revision
            }
          })().finally(() => { held.building = undefined })
        }
        await held.building
        signal?.throwIfAborted()
      }
      const primary = { layerId, path: filePath }
      const revision = String(server.revision)
      if (question.action === 'count') {
        return Object.freeze({ revision, count: held.keys.otherCatalogs(question.key, primary) })
      }
      return Object.freeze({
        revision,
        ...held.keys.locations(question.key, primary,
          { definitions: question.definitions as boolean, uses: question.uses as boolean }, question.maxResults as number),
      })
    }
    let disposed = false
    const workspaceProjection = createContextDataWorkspaceProjection({
      data: chainData, layers: chainLayers, reader: chainReader, revision: () => String(server.revision),
    })
    const context: Sc2ModContext = {
      schemaVersion: 1,
      ...(options.languageFiles === undefined ? {} : { languageModel: 'server' as const }),
      gameId: SC2_GAME_ID,
      contextId,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      layers: Object.freeze(layers),
      unresolved: resolved.unresolved,
      diagnostics: Object.freeze(
        resolved.unresolved.map(name =>
          Object.freeze({
            code: 'blizzard/sc2-dependency-unresolved',
            severity: 'warning',
            message: `${name} is declared but no configured source provides it.`,
          }),
        ),
      ),
      async files(layerId, page) {
        const limit = Math.max(1, Math.min(MAXIMUM_PAGE, Math.trunc(page.limit)))
        const listed = await listing(layerId)
        const prefix = page.prefix?.toLowerCase()
        const all = prefix ? listed.filter(file => file.toLowerCase().startsWith(prefix)) : listed
        const start = page.cursor === undefined ? 0 : Number(page.cursor)
        if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid mod context cursor')
        const items = all.slice(start, start + limit)
        return Object.freeze({
          items,
          ...(start + items.length < all.length ? { nextCursor: String(start + items.length) } : {}),
        })
      },
      read: readFile,
      async locate(filePath) {
        const relative = canonical(filePath).replace(/^\/+/u, '').toLowerCase()
        for (let index = order.length - 1; index >= 0; index -= 1) {
          const files = await resolved.files(order[index] as string)
          for (const spelling of assetSpellings(files, relative, request.locales ?? [])) {
            const listed = server.overlays.get(overlayKey(order[index] as string, spelling))?.path ?? files.byPath.get(spelling)
            if (listed !== undefined) return Object.freeze({ layerId: (layers[index] as Sc2ModContextLayer).id, path: listed })
          }
        }
        return undefined
      },
      async query(request, signal) {
        if ((request as { readonly kind?: unknown } | null)?.kind === 'language.feature') return languageFeatureQuestion(request, signal)
        if ((request as { readonly kind?: unknown } | null)?.kind === 'language.verify') return verifyQuestion(request, signal)
        if ((request as { readonly kind?: unknown } | null)?.kind === 'language.rename' ||
            (request as { readonly kind?: unknown } | null)?.kind === 'language.prepare-rename') return renameQuestion(request, signal)
        if ((request as { readonly kind?: unknown } | null)?.kind === 'data.workspace')
          return workspaceProjection.query(request, signal)
        const treeRequest = request as {
          readonly kind?: unknown
          readonly action?: unknown
          readonly node?: TreeNodeRef
          readonly page?: { readonly cursor?: string; readonly limit: number }
          readonly pattern?: unknown
        } | null
        if (treeRequest?.kind === 'resources.tree') {
          signal?.throwIfAborted()
          const tree = await resourceTree()
          signal?.throwIfAborted()
          if (treeRequest.action === 'root') return tree.root()
          if (treeRequest.node === undefined || typeof treeRequest.node.id !== 'string' ||
              typeof treeRequest.node.hasChildren !== 'boolean') {
            throw new TypeError('resources.tree needs a tree node')
          }
          if (treeRequest.action === 'facts') return tree.facts(treeRequest.node)
          if (treeRequest.action === 'children') {
            const page = treeRequest.page
            if (page === undefined || !Number.isSafeInteger(page.limit) || page.limit < 1 ||
                page.limit > MAXIMUM_PAGE) throw new TypeError('invalid resources.tree page')
            return tree.children(treeRequest.node, page, signal)
          }
          if (treeRequest.action === 'search') {
            if (typeof treeRequest.pattern !== 'string' || treeRequest.pattern.length > 512)
              throw new TypeError('invalid resources.tree search')
            const items: TreeNodeRef[] = []
            for await (const item of tree.search({ pattern: treeRequest.pattern }, signal)) {
              items.push(item)
              if (items.length >= 200) break
            }
            return Object.freeze({ items })
          }
          throw new TypeError('unknown resources.tree action')
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'data.strings') {
          return Object.freeze({ strings: await stringsChain().answer(request, contextLocales, signal) })
        }
        const galaxyKind = (request as { readonly kind?: unknown } | null)?.kind
        if (galaxyKind === 'galaxy.references' || galaxyKind === 'galaxy.hover' || galaxyKind === 'galaxy.completion' ||
            galaxyKind === 'galaxy.diagnostics' ||
            galaxyKind === 'galaxy.definition' || galaxyKind === 'galaxy.signature-help') {
          return galaxyQuestion(galaxyKind, request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'style.definition') {
          return styleDefinition(request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'style.references') {
          return styleReferences(request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'strings.keys') {
          return stringKeysQuestion(request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'strings.diagnostics' ||
            (request as { readonly kind?: unknown } | null)?.kind === 'strings.hover') {
          return stringsDiagnostics(request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'data.references') {
          return dataReferences(request, signal)
        }
        const layoutKind = (request as { readonly kind?: unknown } | null)?.kind
        if (layoutKind === 'layout.definition' || layoutKind === 'layout.hover' || layoutKind === 'layout.completion' ||
            layoutKind === 'layout.diagnostics' || layoutKind === 'layout.references') {
          return layoutQuestion(layoutKind, request, signal)
        }
        if ((request as { readonly kind?: unknown } | null)?.kind === 'data.language') {
          const { languageAnswer } = await import('./language-answer.js')
          const session = await chainData.session(signal)
          signal?.throwIfAborted()
          return languageAnswer(request, {
            session,
            revision: String(server.revision),
            layers: chainLayers,
            strings: (keys, locales, keySignal) =>
              stringsChain().answer(
                { kind: 'data.strings', keys, ...(locales === undefined ? {} : { locales }) },
                contextLocales,
                keySignal,
              ),
          }, signal)
        }
        return dataAnswer(request, signal)
      },
      get revision() {
        return String(server.revision)
      },
      async overlay(changes) {
        if (!Array.isArray(changes) || changes.length > MAXIMUM_PAGE) throw new TypeError('invalid overlay changes')
        for (const change of changes) {
          if (typeof change?.layerId !== 'string' || typeof change.path !== 'string' || change.path === '' ||
              (change.text !== undefined && typeof change.text !== 'string')) {
            throw new TypeError('an overlay change needs a layer, a path and an optional text')
          }
          if (change.text !== undefined && change.text.length > MAXIMUM_OVERLAY_BYTES) {
            throw new TypeError(`an overlay of ${change.path} exceeds ${MAXIMUM_OVERLAY_BYTES} characters`)
          }
        }
        // Resolve every layer and native spelling before committing any changes. A rejected batch
        // must not leave half an overlay behind or let another reader observe a partial edit.
        const planned = []
        for (const change of changes) {
          const vfsPath = vfsPathOf(change.layerId)
          const key = overlayKey(vfsPath, change.path)
          const relative = canonical(change.path).replace(/^\/+/u, '')
          const listed = change.text === undefined ? undefined : (await resolved.files(vfsPath)).byPath.get(relative.toLowerCase())
          planned.push({ change, vfsPath, key, path: listed ?? relative })
        }
        for (const { change, vfsPath, key, path } of planned) {
          // What Resources read and parsed of this layer is no longer what the editor holds.
          server.resources.parsed.delete(vfsPath.toLowerCase())
          server.resources.bytes.delete(`${vfsPath.toLowerCase()}/${canonical(change.path).replace(/^\/+/u, '').toLowerCase()}`)
          if (change.text === undefined) server.overlays.delete(key)
          else server.overlays.set(key, { vfsPath, path, text: change.text })
        }
        // An empty overlay changes nothing: it only asks the server's revision now.
        if (changes.length > 0) { changed(server, changes); workspaceProjection.invalidate() }
        return Object.freeze({ revision: String(server.revision) })
      },
      async invalidate() {
        invalidateSaved(HOST_SOURCE_ID)
        workspaceProjection.invalidate()
        return Object.freeze({ revision: String(server.revision) })
      },
      /** The chain's Data session, built before an editor's first question needs it. */
      async prepare(signal) {
        const session = await chainData.session(signal)
        signal?.throwIfAborted()
        // Prepare canonical state; completeness/Verify remain at the query owners.
        await session.prepare(signal)
      },
      async dispose() {
        if (disposed) return
        disposed = true
        workspaceProjection.dispose()
        server.references -= 1
        if (server.references === 0 && request.sessionId !== undefined) {
          chain.views.delete(request.sessionId)
          server.overlays.clear()
          server.resources.bytes.clear()
          server.resources.parsed.clear()
        }
        if (server.references === 0) resourceTrees.deletePrefix(`${server.resourceScope}:`)
        trim()
      },
    }
    return Object.freeze(context)
  }

  /**
   * Where `open` would place a target, without resolving its chain: the same `locate` decides both,
   * and a path inside a source is read the way `resolveInSource` reads it — the first package
   * segment wins. A replay is not a package: `open` layers the archives it names beneath it, so it
   * answers `loose` like any other file that belongs to no package.
   */
  const placementInSource = (target: SourcePath): Sc2ModPackagePlacement => {
    const segments = canonical(target.path).split('/').filter(Boolean)
    const packageAt = REPLAY.test(target.path) && options.replayLayers !== undefined
      ? -1
      : segments.findIndex(segment => PACKAGE.test(segment))
    if (packageAt < 0) return looseOrForeign(target.path)
    const root = segments.slice(0, packageAt + 1).join('/')
    return Object.freeze({
      kind: 'package' as const,
      sourceId: target.sourceId,
      path: root,
      displayName: segments[packageAt] as string,
    })
  }

  const locateModPackage = async (
    target: Sc2ModContextRequest['target'],
    signal?: AbortSignal,
  ): Promise<Sc2ModPackagePlacement> => {
    signal?.throwIfAborted()
    if (typeof target !== 'string') return placementInSource(target)
    let located
    try {
      located = await locate(target)
    } catch {
      return Object.freeze({ kind: 'missing' as const })
    }
    signal?.throwIfAborted()
    if (located.root !== undefined) {
      const root = canonical(located.root)
      return Object.freeze({
        kind: 'package' as const,
        sourceId: HOST_SOURCE_ID,
        path: root,
        displayName: path.posix.basename(root),
      })
    }
    if (located.source !== undefined) return placementInSource(located.source)
    return looseOrForeign(target)
  }

  return Object.freeze({
    open,
    locateModPackage,
    /** Drop what is cached for packages that changed on disk. */
    invalidate: invalidateSaved,
    dispose: () => { savedLanguages.clear(); resourceTrees.clear(); chains.clear();
      savedBytes.clear(); retainedSavedBytes = 0; return manager.dispose() },
  })
}
