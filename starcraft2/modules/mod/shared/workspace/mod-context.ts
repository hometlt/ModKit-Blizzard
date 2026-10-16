/**
 * StarCraft II's dependency chain over the host's content sources: which packages a package — or a
 * file that belongs to none — loads beneath it, in load order, and the files of each layer.
 *
 * Nothing is parsed here. Every read goes through one virtual file system: the content sources
 * (installation folder, CASC, documents, the Battle.net cache) by protocol, add-on sources the
 * editor loads whatever is open (wizard folders), the folder an opened package sits in as one more
 * content source (a packed package reads as a folder there), and a loose root that declares only
 * its base mods. Merged data is the chain's Data session over these files, held by the chain's
 * server (see `chain-data.ts` and `mod-contexts.ts`).
 * Built-in source package names use the existing engine dependency table's spelling, whether
 * opened directly or inherited. Custom source prefixes and host filesystem paths are preserved.
 * The Mod owner's recoverable metadata policy retains 128 chains/1MiB and 256 layer tables/16MiB
 * of accounted UTF-16 names/slots. Eviction never cancels a caller or truncates its table; a later
 * lookup reconstructs it. Invalidation/failed reads remain retryable. Point reads use native
 * directory membership rather than rebuilding an evicted full layer. Active Data models and
 * environment readers/protocols have separate lifetimes. One environment shares 4096 directories/
 * 8MiB of recoverable source metadata across content sources, add-ons and host folders. Reader
 * invalidation forgets only its protocol namespace; this is not a general heap/RSS ceiling.
 * A loose chain owns its transient reader in a scope over the common source VFS. The shared
 * registry retains no loose reader; weak address lookups are swept on subsequent loose opens
 * after normal GC. Live resolved results pin their scope/address, and manager close revokes reads.
 * Standalone disk readers own no open handles; prefixed source readers own no storage to close.
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { ModResolver, type ResolverSource } from './resolver.js'
import { FsReader, VirtualFileSystem, type BaseReader, type Protocol } from './vfs.js'
import { LoaderMetadataCache } from './loader-metadata-cache.js'
import { canonicalSc2PackagePath } from './implicit-dependencies.js'
import {
  ContentSourceReader,
  createSourceListingCache,
  contentSourceResolver,
  type ContentSourceStorage,
} from './content-source-provider.js'
import {
  parseComponentList,
  parseSc2ComponentList,
} from '../../codecs/document-metadata/core/component-list.js'

/** The source id of a layer on the host's disk: an opened package, its siblings, a loose root. */
export const HOST_SOURCE_ID = 'host'

/** How a layer joined the chain: declared by a package, implied by the engine, or a setting's base. */
export type LayerProvenance = 'declared' | 'implicit' | 'setting'

/** One layer's files, listed once and shared by every context over it. */
export interface LayerFiles {
  /** Every file, recursively, relative to the layer, in code-unit order. */
  readonly list: readonly string[]
  /** Each file by its lower-cased path; built only when a spelling lookup is requested. */
  readonly byPath: ReadonlyMap<string, string>
}

/** A package's layers in load order, and the files of each. */
export interface ResolvedMod {
  /** Load-order VFS paths: dependencies first, the package itself last. */
  readonly order: readonly string[]
  /** Dependency names that could not be resolved from any configured source. */
  readonly unresolved: readonly string[]
  /** How each dependency joined the chain, keyed by its VFS path lower-cased. */
  readonly layerProvenance: ReadonlyMap<string, LayerProvenance>
  files(layer: string): Promise<LayerFiles>
  /** A file the layer lists (any case); undefined for one it does not. */
  read(layer: string, filePath: string): Promise<Uint8Array | undefined>
  /** Content identities of layers that have one, keyed by VFS path lower-cased. */
  readonly fingerprints: ReadonlyMap<string, string>
}

/** Where a layer lives: a content source and its path there, or the host disk and its path. */
export interface LayerSource {
  readonly id: string
  /** `Mods/Core.SC2Mod` in a content source; an absolute path with forward slashes on the host. */
  readonly path: string
  /** A source the editor loads whatever is open (a wizard folder), not a package dependency. */
  readonly addOn?: boolean
}

/** A path inside one of the content sources. */
export interface SourcePath {
  readonly sourceId: string
  readonly path: string
}

/** Layers a subject that is no package depends on (a replay's archives), found by the game. */
export interface PresetLayers {
  /**
   * In load order; a layer's `fingerprint` names its content (`content-hash.sha256:…`). Layers of a
   * source with a `revision` get one from it without being named here.
   */
  readonly layers: readonly (SourcePath & { readonly fingerprint?: string })[]
  /** What the subject names but no source holds. */
  readonly unresolved: readonly string[]
}

const MOD_ROOT_RE = /\.(sc2mod|sc2map|sc2campaign)$/i
/** Give built-in source packages their game spelling without stripping a custom path prefix. */
export function canonicalSourcePackageRoot(value: string): string {
  const known = canonicalSc2PackagePath(value)
  return known !== undefined && known.toLowerCase() === value.toLowerCase() ? known : value
}
/** Protocol prefix of a root opened outside any package (see {@link ModContextManager.resolveLoose}). */
const LOOSE_ROOT = /^loose\d+:/iu

const trim = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const lastSegment = (p: string): string => trim(p).slice(trim(p).lastIndexOf('/') + 1)

/** Paths of one reader under a folder of another: `prefixed(vfs, 'content-source0:')`. */
function prefixed(vfs: VirtualFileSystem, protocol: Protocol): BaseReader {
  return {
    list: p => vfs.list(`${protocol}${trim(p)}`),
    get: p => vfs.get(`${protocol}${trim(p)}`),
    getText: p => vfs.getText(`${protocol}${trim(p)}`),
    readListed: (root, file) => vfs.readListed(`${protocol}${trim(root)}`, file),
    exists: p => vfs.exists(`${protocol}${trim(p)}`),
  }
}

/**
 * A file — or a folder of files — that belongs to no package, as the root of a package whose
 * DocumentInfo declares nothing but `baseMods`. A folder serves every file under it; the
 * declaration exists only so the chain resolves and is not listed as a file. `reader` holds the
 * file: the host disk or a content source.
 */
function looseFileReader(
  rootName: string,
  reader: BaseReader,
  rootPath: string,
  baseMods: readonly string[],
): BaseReader {
  const documentInfo = `<?xml version="1.0" encoding="utf-8"?>
<DocInfo><Dependencies>${baseMods
    .map(name => `<Value>file:${normalizeDependencyRef(name)}</Value>`)
    .join('')}</Dependencies></DocInfo>
`
  // A folder lists; a single file does not.
  let listing: Promise<string[] | undefined> | undefined
  const folderFiles = (): Promise<string[] | undefined> =>
    (listing ??= reader.list(rootPath).then(
      files => files,
      () => undefined,
    ))
  /** Files served, by their path relative to the loose root. */
  const files = async (): Promise<string[]> => (await folderFiles()) ?? [lastSegment(rootPath)]
  const inner = (filePath: string): string | undefined => {
    const normalized = trim(filePath)
    if (normalized.toLowerCase() === rootName.toLowerCase()) return ''
    const prefix = `${rootName.toLowerCase()}/`
    return normalized.toLowerCase().startsWith(prefix) ? normalized.slice(prefix.length) : undefined
  }
  /** The reader's path behind a relative path, or undefined when the root does not serve it. */
  const sourceFileOf = async (relative: string): Promise<string | undefined> => {
    const wanted = relative.toLowerCase()
    const hit = (await files()).find(file => file.toLowerCase() === wanted)
    if (hit === undefined) return undefined
    return (await folderFiles()) === undefined ? rootPath : `${forward(rootPath)}/${hit}`
  }
  const read = async (filePath: string): Promise<Uint8Array> => {
    const relative = inner(filePath)
    if (relative === 'DocumentInfo') return new TextEncoder().encode(documentInfo)
    const file = relative === undefined ? undefined : await sourceFileOf(relative)
    if (file === undefined) throw new Error(`${filePath} is not part of ${rootName}`)
    return reader.get(file)
  }
  return {
    list: async filePath => {
      const relative = inner(filePath)
      if (relative === undefined) return []
      const start = relative === '' ? '' : `${relative.toLowerCase()}/`
      return (await files())
        .filter(file => file.toLowerCase().startsWith(start))
        .map(file => file.slice(start.length))
    },
    get: read,
    getText: async filePath => new TextDecoder().decode(await read(filePath)),
    exists: async filePath => {
      const relative = inner(filePath)
      if (relative === undefined) return false
      return relative === '' || relative === 'DocumentInfo' || (await sourceFileOf(relative)) !== undefined
    },
  }
}

/** A path as a lookup key: forward slashes, no trailing slash, lower-case. */
function pathKey(p: string): string {
  return forward(p).toLowerCase()
}

/** A host path with forward slashes and no trailing slash. */
function forward(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

interface DependencyRef {
  /** Package name, e.g. `Scion-Assets.SC2Mod`. */
  readonly name: string
  /** Path-like reference when there is one, e.g. `Mods/Scion-Assets.SC2Mod`. */
  readonly ref: string
}

function normalizeDependencyRef(ref: string): string {
  return ref
    .replace(/^[a-z][a-z0-9+.-]*:/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

/** The last path segment of a reference — the package name. */
function depName(ref: string): string {
  const normalized = normalizeDependencyRef(ref)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function dependencyRef(ref: string): DependencyRef {
  const normalized = normalizeDependencyRef(ref)
  return { name: depName(normalized), ref: normalized }
}

/** The `file:` dependency references of a DocumentInfo. */
function docInfoDepRefs(xml: string): DependencyRef[] {
  const out: DependencyRef[] = []
  for (const m of xml.matchAll(/<Value>([^<]+)<\/Value>/g)) {
    const val = m[1]?.trim()
    if (!val) continue
    const idx = val.lastIndexOf('file:')
    if (idx !== -1) out.push(dependencyRef(val.slice(idx + 5)))
  }
  return out
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

async function isDir(p: string): Promise<boolean> {
  return fs.stat(p).then(
    s => s.isDirectory(),
    () => false,
  )
}

interface SourceProtocol {
  readonly id: string
  readonly protocol: Protocol
  readonly addOn: boolean
  readonly revision?: string
}

/** Address metadata only; a transient chain owns its strong copy, the manager holds a weak lookup. */
interface LooseRoot {
  readonly id: string
  readonly path: string
  readonly exact: true
}

/** The file system over one set of content sources, and the resolver over them in their order. */
interface Environment {
  readonly vfs: VirtualFileSystem
  /** Readers belong to this generation, including registrations while its opening is pending. */
  readonly readers: Map<ContentSourceReader, string>
  readonly listings: ReturnType<typeof createSourceListingCache>
  readonly resolver: ModResolver
  readonly sources: readonly SourceProtocol[]
  /** Host folders opened packages sit in, by path key, to their protocol. */
  readonly hostFolders: Map<string, Protocol>
  /** Where each host-folder or loose protocol reads from: a host path, or a content source path. */
  readonly roots: Map<string, { readonly id: string; readonly path: string; readonly exact: boolean }>
  readonly looseRoots: Map<string, WeakRef<LooseRoot>>
  /** Pins address metadata alongside this scope's reader while its resolved result is alive. */
  readonly looseRoot?: LooseRoot
  serial: number
}

/** Resolves and caches packages' chains and layer listings over the host's content sources. */
export class ModContextManager {
  private env: Promise<Environment> | undefined
  private envKey = ''
  private readonly resolved = new LoaderMetadataCache<ResolvedMod>(128, 1024 * 1024,
    value => [...value.order, ...value.unresolved, ...value.layerProvenance.keys(),
      ...[...value.fingerprints].flat()].reduce((weight, name) => weight + name.length * 2 + 32, 0))
  /** Layer listings; reserve the full map footprint even while its spelling index is still lazy. */
  private readonly layerFiles = new LoaderMetadataCache<LayerFiles>(256, 16 * 1024 * 1024,
    value => value.list.reduce((weight, name) => weight + name.length * 4 + 32, 0))
  /** The environment's readers by the source each reads (`host` for open package folders). */
  private readers = new Map<ContentSourceReader, string>()

  constructor(
    /** Read on every resolve: a source added in the host is seen by the next one. */
    private readonly contentSources: () => ReadonlyMap<string, ContentSourceStorage>,
    /** A host folder as a content source, packed packages in it read as folders. */
    private readonly hostFolder: (directory: string) => ContentSourceStorage,
    /** Sources the editor loads whatever is open (wizard folders): a layer of every chain. */
    private readonly addOnSources: () => ReadonlyMap<string, ContentSourceStorage> = () => new Map(),
  ) {}

  /** The file system over the current content sources; rebuilt, dropping every cache, when they change. */
  private environment(): Promise<Environment> {
    const storages = this.contentSources()
    const addOns = this.addOnSources()
    const key = [...storages.keys(), '|', ...addOns.keys()].join('\n')
    if (this.env !== undefined && key === this.envKey) return this.env
    const previous = this.env
    this.invalidate()
    this.envKey = key
    const readers = new Map<ContentSourceReader, string>()
    // Leave room for small resolver directories across sources within the same 8MiB byte budget.
    const listings = createSourceListingCache(4096)
    this.readers = readers
    this.env = (async () => {
      await previous?.then(async env => {
        try { await env.vfs.close() } finally { env.listings.clear(); env.readers.clear() }
      }).catch(() => {})
      const vfs = new VirtualFileSystem()
      const resolvers: ResolverSource[] = []
      const sources: SourceProtocol[] = []
      for (const storage of storages.values()) {
        const protocol: Protocol = `content-source${sources.length}:`
        const reader = new ContentSourceReader(storage, listings, protocol)
        readers.set(reader, storage.id)
        vfs.register(protocol, reader)
        resolvers.push(contentSourceResolver(protocol, reader, storage.id))
        sources.push({ id: storage.id, protocol, addOn: false, ...(storage.revision === undefined ? {} : { revision: storage.revision }) })
      }
      for (const storage of addOns.values()) {
        const protocol: Protocol = `add-on${sources.length}:`
        const reader = new ContentSourceReader(storage, listings, protocol)
        readers.set(reader, storage.id)
        vfs.register(protocol, reader)
        sources.push({ id: storage.id, protocol, addOn: true, ...(storage.revision === undefined ? {} : { revision: storage.revision }) })
      }
      const resolver = new ModResolver({ sources: resolvers })
      return { vfs, readers, listings, resolver, sources, hostFolders: new Map(), roots: new Map(), looseRoots: new Map(), serial: 0 }
    })()
    return this.env
  }

  /** Where a layer this manager resolved lives. */
  async sourceOf(layer: string): Promise<LayerSource> {
    const env = await this.environment()
    const protocol = layer.slice(0, layer.indexOf(':') + 1).toLowerCase()
    const rest = trim(layer.slice(protocol.length))
    const source = env.sources.find(item => item.protocol === protocol)
    if (source !== undefined) return { id: source.id, path: canonicalSourcePackageRoot(rest), ...(source.addOn ? { addOn: true } : {}) }
    const root = env.roots.get(protocol) ?? env.looseRoots.get(protocol)?.deref()
    if (root === undefined) throw new Error(`${layer} is not a layer this loader resolved`)
    return { id: root.id, path: root.exact || rest === '' ? root.path : `${root.path}/${rest}` }
  }

  /**
   * Forget resolved chains and listings (after a package changed on disk), and the directory
   * listings of `sourceId` (`host`: the open package folders), else of every source — so a file
   * added to a package is listed, not only a changed one reread.
   */
  invalidate(sourceId?: string): void {
    this.resolved.clear()
    this.layerFiles.clear()
    for (const [reader, id] of this.readers) if (sourceId === undefined || id === sourceId) reader.forget()
  }

  async dispose(): Promise<void> {
    const current = this.env
    this.env = undefined
    this.envKey = ''
    this.invalidate()
    this.readers = new Map()
    await current?.then(async env => {
      // Close and clear exactly the captured generation, including its late registrations.
      try { await env.vfs.close() } finally { env.listings.clear(); env.readers.clear() }
    }).catch(() => {})
  }

  /**
   * Walk up from a file to the nearest enclosing package directory: a `.SC2Mod`/`.SC2Map`/
   * `.SC2Campaign` folder, or one with `ComponentList.SC2Components`/`DocumentInfo`. A folder that
   * only holds `GameData`/`Base.SC2Data` counts when nothing stronger encloses it (an unpacked mod
   * without marker files) — taken eagerly it would stop at `Base.SC2Data` itself.
   */
  async findModRoot(filePath: string): Promise<string | undefined> {
    let dir = path.dirname(filePath)
    let fallback: string | undefined
    for (let i = 0; i < 64; i++) {
      if (MOD_ROOT_RE.test(path.basename(dir))) return dir
      if (await exists(path.join(dir, 'ComponentList.SC2Components'))) return dir
      if (await exists(path.join(dir, 'DocumentInfo'))) return dir
      if (
        fallback === undefined &&
        ((await isDir(path.join(dir, 'GameData'))) || (await isDir(path.join(dir, 'Base.SC2Data'))))
      ) {
        fallback = dir
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return fallback
  }

  /** The chain of the package at `hostPath` — a folder, or a packed file read as one. */
  resolve(hostPath: string): Promise<ResolvedMod> {
    return this.resolved.get(pathKey(hostPath), async () => {
      const env = await this.environment()
      const folder = forward(path.dirname(hostPath))
      let protocol = env.hostFolders.get(folder.toLowerCase())
      if (protocol === undefined) {
        protocol = `host${env.serial++}:`
        const reader = new ContentSourceReader(this.hostFolder(path.dirname(hostPath)), env.listings, protocol)
        env.readers.set(reader, HOST_SOURCE_ID)
        env.vfs.register(protocol, reader)
        env.hostFolders.set(folder.toLowerCase(), protocol)
        env.roots.set(protocol, { id: HOST_SOURCE_ID, path: folder, exact: false })
      }
      return this.resolveChain(env, `${protocol}${path.basename(hostPath)}`)
    })
  }

  /**
   * The chain of a file or folder that belongs to no package, read as though it lived inside
   * `baseMods` — a trigger script, a Galaxy script or a model opened on its own. It becomes the
   * primary layer of a package that declares nothing but those bases, so its chain resolves as any
   * other package's; the bases are recorded as chosen by a setting. `preset` are layers the subject
   * itself depends on (a replay's archives), resolved beneath it before anything it declares.
   */
  resolveLoose(hostPath: string, baseMods: readonly string[], preset?: PresetLayers): Promise<ResolvedMod> {
    return this.looseChain(
      `host:${pathKey(hostPath)}`,
      { id: HOST_SOURCE_ID, path: forward(hostPath) },
      () => new FsReader(),
      hostPath,
      baseMods,
      preset,
    )
  }

  /**
   * The chain of a path inside one of the content sources: the package the path is in (its first
   * `.SC2Mod`/`.SC2Map`/`.SC2Campaign` segment), else the path as a loose root inside `baseMods`.
   */
  resolveInSource(target: SourcePath, baseMods: readonly string[], preset?: PresetLayers): Promise<ResolvedMod> {
    const segments = trim(target.path).split('/').filter(Boolean)
    const packageAt = segments.findIndex(segment => MOD_ROOT_RE.test(segment))
    if (packageAt >= 0 && preset === undefined) {
      const root = segments.slice(0, packageAt + 1).join('/')
      return this.resolved.get(`source:${target.sourceId}|${root.toLowerCase()}`, async () => {
        const env = await this.environment()
        return this.resolveChain(env, `${this.protocolOf(env, target.sourceId)}${root}`)
      })
    }
    return this.environment().then(env =>
      this.looseChain(
        `source:${target.sourceId}|${segments.join('/').toLowerCase()}`,
        { id: target.sourceId, path: segments.join('/') },
        () => prefixed(env.vfs, this.protocolOf(env, target.sourceId)),
        segments.join('/'),
        baseMods,
        preset,
      ),
    )
  }

  private protocolOf(env: Environment, sourceId: string): Protocol {
    const source = env.sources.find(item => item.id === sourceId && !item.addOn)
    if (source === undefined) throw new Error(`no content source '${sourceId}' is configured`)
    return source.protocol
  }

  private looseChain(
    identity: string,
    root: { readonly id: string; readonly path: string },
    reader: () => BaseReader,
    rootPath: string,
    baseMods: readonly string[],
    preset: PresetLayers | undefined,
  ): Promise<ResolvedMod> {
    const key = `loose:${identity}|${baseMods
      .map(name => normalizeDependencyRef(name).toLowerCase())
      .join(',')}|${(preset?.layers ?? []).map(item => `${item.sourceId}:${item.path}`).join(',')}`
    return this.resolved.get(key, async () => {
      const shared = await this.environment()
      // Dead address lookups are recoverable metadata, never owners of the loose reader.
      for (const [protocol, root] of shared.looseRoots) if (root.deref() === undefined) shared.looseRoots.delete(protocol)
      const protocol: Protocol = `loose${shared.serial++}:`
      const rootName = `${lastSegment(rootPath)}.loose`
      const looseRoot: LooseRoot = { ...root, exact: true }
      const vfs = new VirtualFileSystem(shared.vfs)
      vfs.register(protocol, looseFileReader(rootName, reader(), rootPath, baseMods))
      shared.looseRoots.set(protocol, new WeakRef(looseRoot))
      const env: Environment = { ...shared, vfs, looseRoot }
      const layers = (preset?.layers ?? []).map(item => ({
        ...item,
        vfsPath: `${this.protocolOf(env, item.sourceId)}${trim(item.path)}`,
      }))
      return this.resolveChain(
        env,
        `${protocol}${rootName}`,
        layers.map(item => item.vfsPath),
        preset?.unresolved ?? [],
        new Map(
          layers.flatMap(item =>
            item.fingerprint === undefined ? [] : [[item.vfsPath.toLowerCase(), item.fingerprint] as const],
          ),
        ),
      )
    })
  }

  /**
   * The flattened chain (deepest first) of the package at `activePath`: first the `preset` layers
   * and what they load, then each declared dependency resolved by the content sources in order —
   * its path-qualified reference, then its name — and, last, next to the package that declares it
   * (a mod collection folder keeps its parts side by side). Unresolved dependencies are recorded
   * and skipped. Core, the implicit base of everything, is prepended when a source holds it; the
   * add-on sources come after the dependencies, beneath the package itself.
   */
  private async resolveChain(
    env: Environment,
    activePath: string,
    preset: readonly string[] = [],
    presetUnresolved: readonly string[] = [],
    fingerprints: ReadonlyMap<string, string> = new Map(),
  ): Promise<ResolvedMod> {
    const ordered: string[] = []
    const unresolved: string[] = [...presetUnresolved]
    const provenance = new Map<string, LayerProvenance>()
    const seen = new Set<string>()
    const loose = LOOSE_ROOT.test(activePath)
    const add = (layer: string, how: LayerProvenance): void => {
      if (ordered.some(p => p.toLowerCase() === layer.toLowerCase())) return
      ordered.push(layer)
      provenance.set(layer.toLowerCase(), how)
    }

    const visit = async (vfsPath: string): Promise<void> => {
      const key = vfsPath.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const slash = vfsPath.lastIndexOf('/')
      const parent = slash >= 0 ? vfsPath.slice(0, slash + 1) : vfsPath.slice(0, vfsPath.indexOf(':') + 1)
      const sibling = async (name: string): Promise<string | undefined> => {
        if (!MOD_ROOT_RE.test(name)) return undefined
        const candidate = `${parent}${name}`
        return (await env.vfs.exists(candidate).catch(() => false)) ? candidate : undefined
      }
      for (const { name, ref } of await this.readDepRefs(env, vfsPath)) {
        const resolved =
          (await env.resolver.resolve(ref)) ?? (await env.resolver.resolve(name)) ?? (await sibling(name))
        if (!resolved) {
          if (!unresolved.includes(name)) unresolved.push(name)
          continue
        }
        await visit(resolved)
        add(resolved, loose && vfsPath === activePath ? 'setting' : 'declared')
      }
    }

    for (const layer of preset) {
      await visit(layer)
      add(layer, 'declared')
    }
    await visit(activePath)

    const core = await env.resolver.resolve('Mods/Core.SC2Mod')
    if (
      core &&
      depName(activePath).toLowerCase() !== 'core.sc2mod' &&
      !ordered.some(p => p.toLowerCase() === core.toLowerCase())
    ) {
      ordered.unshift(core)
      provenance.set(core.toLowerCase(), 'implicit')
    }
    for (const source of env.sources) if (source.addOn) add(source.protocol, 'setting')

    const order = Object.freeze([...ordered, activePath])
    const inChain = new Set(order.map(pathKey))
    const files = (layer: string): Promise<LayerFiles> => {
      const key = pathKey(layer)
      if (!inChain.has(key)) return Promise.reject(new Error(`${layer} is not a layer of this chain`))
      return this.layerFiles.get(key, async () => {
        const list = (await env.vfs.list(layer)).sort((left, right) => (left < right ? -1 : 1))
        let byPath: ReadonlyMap<string, string> | undefined
        return Object.freeze({
          list: Object.freeze(list),
          get byPath() {
            return byPath ??= new Map(list.map(file => [file.toLowerCase(), file]))
          },
        })
      })
    }
    // A layer of a source whose content its revision names (CASC) is named by it too.
    const fingerprintOf = (layer: string): string | undefined => {
      const source = env.sources.find(item => item.revision !== undefined && layer.startsWith(item.protocol))
      return fingerprints.get(layer.toLowerCase()) ?? (source === undefined ? undefined
        : `provider-token:${encodeURIComponent(`${source.revision}/${layer.slice(source.protocol.length).toLowerCase()}`)}`)
    }
    return Object.freeze({
      order,
      unresolved: Object.freeze(unresolved),
      layerProvenance: provenance,
      fingerprints: new Map(order.flatMap(layer => {
        const fingerprint = fingerprintOf(layer)
        return fingerprint === undefined ? [] : [[layer.toLowerCase(), fingerprint] as const]
      })),
      files,
      read: async (layer: string, filePath: string): Promise<Uint8Array | undefined> => {
        if (!inChain.has(pathKey(layer))) throw new Error(`${layer} is not a layer of this chain`)
        return env.vfs.readListed(layer, filePath)
      },
    })
  }

  /** A package's dependencies from its metadata, including metadata projected by its source. */
  private async readDepRefs(env: Environment, vfsPath: string): Promise<DependencyRef[]> {
    const base = vfsPath.replace(/\/+$/, '')
    const declared: DependencyRef[] = []
    try {
      declared.push(...docInfoDepRefs(await env.vfs.getText(`${base}/DocumentInfo`)))
    } catch {
      /* no DocumentInfo */
    }
    if (declared.length === 0) {
      try {
        const text = await env.vfs.getText(`${base}/ComponentList.SC2Components`)
        // A real ComponentList declares data components, not dependencies (DocumentInfo does);
        // only the legacy flat-text form lists dependency paths, one per line.
        if (!parseComponentList(text).isXml) {
          declared.push(
            ...parseSc2ComponentList(text)
              .filter(line => MOD_ROOT_RE.test(line))
              .map(dependencyRef),
          )
        }
      } catch {
        /* no ComponentList */
      }
    }
    return declared
  }
}
