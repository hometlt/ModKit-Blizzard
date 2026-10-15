/**
 * SC2 Mod owner: plan additive imports into one unpacked asset library per source
 * game. Content hashes name media; source references accumulate without duplicating
 * identical bytes. Native catalog declarations use the Data serializer and its
 * raw-preserving insertion owner; package metadata uses jsonModToFiles.
 * CTile callers can opt road-model M3 into a compact content-addressed path profile,
 * retaining full-hash identity/collision checks and all default/legacy bindings.
 * An explicit native version profile can complete missing declared component sidecars.
 * Existing opaque files and definitions are never deleted or replaced. Conflicting
 * identities, foreign-game indexes and modified managed media are refused.
 * This pure planner performs no filesystem writes, model/texture conversion or
 * gameplay inference. Host transactions/export callers own committing its files.
 */
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { jsonModToFiles, JSON_MOD_FORMAT, type JsonModEntity } from './json-mod.js'
import { entityToXml } from '../../data/shared/format/entity-xml.js'
import { catalogNamespaceFileName } from '../../data/shared/format/export.js'
import { insertCatalogEntityXml } from '../../data/services/editing/catalog-field-patch.js'
import { writeSc2DocumentInfoDependencies } from '../codecs/document-metadata/dependencies.js'
import { planSc2ComponentVersions } from '../codecs/document-metadata/core/component-list.js'
import type { VersionFileWriteInput } from '../codecs/document-metadata/core/types.js'

export const SC2_ASSET_LIBRARY_INDEX = 'ModkitAssetLibrary.json'

/** Compact content identity for generated TerrainTex records. The editor pilot accepts this
 * 26-character profile and rejects tested 40-character identities; no global Data ID limit is inferred.
 * Registration below still detects different definitions sharing the shortened identity. */
export function sc2TerrainTextureId(contentHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(contentHash)) throw new TypeError('Terrain texture identity needs a lowercase SHA256')
  return `T_${contentHash.slice(0, 24)}`
}
const utf8 = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
export interface Sc2LibraryAsset {
  kind: 'texture' | 'model' | 'road-model'
  extension: 'dds' | 'm3'
  sourceKey: string
  bytes: Uint8Array
  /** Opt-in CTile Editor profile; full hashes still identify content and detect path collisions. */
  pathProfile?: 'compact-road'
}
export interface Sc2LibraryDefinition { namespace: string; id: string; entity: JsonModEntity }
export interface Sc2AssetLibraryImport {
  sourceGameId: string
  libraryName: string
  dependencies: readonly string[]
  assets: readonly Sc2LibraryAsset[]
  definitions?: readonly Sc2LibraryDefinition[]
  /** Target profile read from native metadata; omitted for legacy virtual-only imports. */
  versionProfile?: VersionFileWriteInput
  maxBytes?: number
  signal?: AbortSignal
}
interface AssetRecord { kind: Sc2LibraryAsset['kind']; extension: string; hash: string; path: string; sourceKeys: string[]; pathProfile?: 'compact-road' }
interface LibraryIndex { schemaVersion: 1; sourceGameId: string; libraryName: string; assets: Record<string, AssetRecord>; definitions: Record<string, string> }

/** Only an existing caller-selected source game names a library; no game-specific rule exists here. */
function identity(value: string, label: string, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${label}`)
}

/** Prepare files to create/add, preserving the rest of the selected unpacked mod. */
export async function planSc2AssetLibraryImport(existing: ReadonlyMap<string, Uint8Array>, request: Sc2AssetLibraryImport): Promise<{
  files: readonly { path: string; bytes: Uint8Array }[]
  bindings: readonly AssetRecord[]
  dependency: string
}> {
  identity(request.sourceGameId, 'source game ID', /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u)
  identity(request.libraryName, 'library name', /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)
  const maxBytes = request.maxBytes ?? 128 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024 || request.assets.length > 512 || (request.definitions?.length ?? 0) > 2048)
    throw new RangeError('Asset library import exceeds its bounded profile')
  if (!Array.isArray(request.dependencies) || request.dependencies.length > 64 ||
      request.dependencies.some(dep => !/^[A-Za-z0-9_-]+\.SC2Mod$/iu.test(dep))) throw new TypeError('Asset library needs explicit mod dependency names')
  const paths = new Map<string, string>()
  for (const path of existing.keys()) {
    const key = path.replaceAll('\\', '/').toLowerCase()
    if (paths.has(key)) throw new TypeError('Case-ambiguous asset library member')
    paths.set(key, path)
  }
  const read = (path: string) => { const actual = paths.get(path.toLowerCase()); return actual === undefined ? undefined : existing.get(actual) }
  const writes = new Map<string, { path: string; bytes: Uint8Array }>()
  let outputBytes = 0
  const write = (path: string, bytes: Uint8Array) => {
    const key = path.toLowerCase(), actual = paths.get(key) ?? path
    const before = read(path)
    if (before && before.length === bytes.length && before.every((v, i) => v === bytes[i])) return
    outputBytes += bytes.length - (writes.get(key)?.bytes.length ?? 0)
    if (outputBytes > maxBytes) throw new RangeError('Asset library output exceeds byte budget')
    writes.set(key, { path: actual, bytes })
  }
  const previous = read(SC2_ASSET_LIBRARY_INDEX)
  if (previous && previous.length > 8 << 20) throw new RangeError('Asset library index exceeds byte budget')
  const loaded: LibraryIndex = previous ? snapshotJson(JSON.parse(decoder.decode(previous)), { maxBytes: 8 << 20, maxDepth: 32, maxNodes: 200000 }) as unknown as LibraryIndex :
    { schemaVersion: 1, sourceGameId: request.sourceGameId, libraryName: request.libraryName, assets: {}, definitions: {} }
  if (!loaded || loaded.schemaVersion !== 1 || loaded.sourceGameId !== request.sourceGameId || loaded.libraryName !== request.libraryName ||
      !loaded.assets || Array.isArray(loaded.assets) || typeof loaded.assets !== 'object' || !loaded.definitions || Array.isArray(loaded.definitions) || typeof loaded.definitions !== 'object')
    throw new TypeError('Selected asset library has an incompatible identity/index')
  const index: LibraryIndex = { ...loaded, assets: { ...loaded.assets }, definitions: { ...loaded.definitions } }
  if (!previous) for (const file of jsonModToFiles({ manifest: { format: JSON_MOD_FORMAT, name: request.libraryName }, deps: [...request.dependencies], entries: {} })) {
    if (read(file.path)) throw new TypeError('An existing mod must be explicitly adopted before initializing its managed library index')
    write(file.path, typeof file.content === 'string' ? utf8.encode(file.content) : file.content)
  }
  if (!previous && !writes.has('documentinfo')) write('DocumentInfo', writeSc2DocumentInfoDependencies([]))
  const bindings: AssetRecord[] = []
  let inputBytes = 0
  for (const asset of request.assets) {
    request.signal?.throwIfAborted()
    if (asset.pathProfile !== undefined && (asset.pathProfile !== 'compact-road' || asset.kind !== 'road-model' || asset.extension !== 'm3'))
      throw new TypeError('Compact road path profile requires a road-model M3')
    if (!(asset.bytes instanceof Uint8Array) || asset.bytes.length === 0 ||
        !['texture', 'model', 'road-model'].includes(asset.kind) ||
        (asset.kind === 'texture' ? asset.extension !== 'dds' : asset.extension !== 'm3')) throw new TypeError('Unsupported encoded library asset')
    identity(asset.sourceKey, 'source reference', /^[^\u0000-\u001f]{1,4096}$/u)
    inputBytes += asset.bytes.length
    if (inputBytes > maxBytes) throw new RangeError('Asset library input exceeds byte budget')
    // The hash and planned media must name the same owned bytes across the async digest.
    const ownedBytes = asset.bytes.slice()
    // CTile needs a separately qualified short-path candidate. Legacy media remain additive;
    // an explicit profile key avoids silently relocating existing full-hash records or references.
    const hash = await sha256Hex(ownedBytes), key = `${asset.kind}:${hash}${asset.pathProfile === undefined ? '' : ':compact-road'}`
    const path = asset.pathProfile === 'compact-road' ? `Assets/R${hash.slice(0, 16)}.m3` : `Assets/Modkit/${asset.kind}/${hash}.${asset.extension}`
    const record = index.assets[key]
    if (record && (record.kind !== asset.kind || record.hash !== hash || record.path !== path || record.extension !== asset.extension ||
        record.pathProfile !== asset.pathProfile ||
        !Array.isArray(record.sourceKeys) || !record.sourceKeys.every(s => typeof s === 'string'))) throw new TypeError('Invalid managed asset index record')
    const bytes = read(path) ?? writes.get(path.toLowerCase())?.bytes
    if (record && (!bytes || await sha256Hex(bytes) !== hash)) throw new TypeError('Managed asset bytes changed or are missing')
    if (!record && bytes && await sha256Hex(bytes) !== hash) throw new TypeError('Library asset path collision')
    if (!bytes && !writes.has(path.toLowerCase())) write(path, ownedBytes)
    const next: AssetRecord = { kind: asset.kind, extension: asset.extension, hash, path,
      ...(asset.pathProfile === undefined ? {} : { pathProfile: asset.pathProfile }),
      sourceKeys: [...new Set([...(record?.sourceKeys ?? []), asset.sourceKey])].sort() }
    index.assets[key] = next; bindings.push(next)
  }
  for (const definition of request.definitions ?? []) {
    request.signal?.throwIfAborted()
    identity(definition.namespace, 'catalog namespace', /^[A-Za-z][A-Za-z0-9_]{0,63}$/u)
    identity(definition.id, 'catalog ID', /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u)
    const entity = snapshotJson(definition.entity, { maxDepth: 32, maxNodes: 10000, maxBytes: 1 << 20 }) as JsonModEntity
    const { class: className = `C${definition.namespace}`, parent, ...fields } = entity
    identity(className, 'catalog class', /^C[A-Za-z][A-Za-z0-9_]{0,127}$/u)
    const declaration = entityToXml(className, definition.id, parent, fields as never, false, { indent: '    ', writeDefaultAttr: false }).trim()
    const digest = await sha256Hex(utf8.encode(declaration)), key = `${definition.namespace}/${definition.id}`
    if (index.definitions[key] && index.definitions[key] !== digest) throw new TypeError('Managed catalog identity conflicts with a different definition')
    const path = `base.sc2data/GameData/${catalogNamespaceFileName(definition.namespace)}`, pending = writes.get(path.toLowerCase())
    const xml = decoder.decode(pending?.bytes ?? read(path) ?? utf8.encode('<Catalog></Catalog>'))
    const result = insertCatalogEntityXml(xml, className, definition.id, declaration)
    if (!result.changed && !index.definitions[key]) throw new TypeError(`Cannot insert ${key}: ${result.reason ?? 'catalog identity conflict'}`)
    if (index.definitions[key] && result.changed) throw new TypeError(`Managed catalog definition is missing: ${key}`)
    if (result.changed) write(path, utf8.encode(result.text))
    index.definitions[key] = digest
  }
  index.assets = Object.fromEntries(Object.entries(index.assets).sort(([a], [b]) => a.localeCompare(b)))
  index.definitions = Object.fromEntries(Object.entries(index.definitions).sort(([a], [b]) => a.localeCompare(b)))
  write(SC2_ASSET_LIBRARY_INDEX, utf8.encode(JSON.stringify(index, null, 2)))
  if (request.versionProfile !== undefined) {
    const packageFiles = new Map(existing)
    for (const file of writes.values()) packageFiles.set(file.path, file.bytes)
    for (const file of planSc2ComponentVersions(packageFiles, request.versionProfile)) write(file.path, file.bytes)
  }
  return { files: [...writes.values()], bindings, dependency: `file:Mods\\${request.libraryName}.SC2Mod` }
}
