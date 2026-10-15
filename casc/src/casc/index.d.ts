/**
 * Types of the part of `@modkit/blizzard-casc` TypeScript reads. The package is JS; what is not
 * declared here is not typed yet — add it here, not as `declare module` in a consumer.
 */
export interface CascFileSource {
  list(path: string): Promise<readonly string[]>
  get(path: string): Promise<Uint8Array>
  getRange(path: string, offset: number, length: number): Promise<Uint8Array>
  exists(path: string): Promise<boolean>
  close?(): Promise<void>
}
/** A parsed root index kept between opens, keyed by the root's content key. */
export interface CascRootCache {
  load(key: string, kind?: string): Promise<Uint8Array | undefined>
  store(key: string, bytes: Uint8Array, kind?: string): Promise<void>
}
/** Normalized (lower-case, `/`-separated) keys of every stored file, sorted. */
export interface CascEntryIndex {
  readonly size: number
  lowerBound(key: string): number
  keyAt(index: number): string
  contentSizeAt(index: number): number
  /** Keys of rows `start..end` as bytes, with nothing made per row; `false` from `visit` stops. */
  forEachKey(start: number, end: number,
    visit: (bytes: Uint8Array, from: number, to: number, row: number) => boolean | void): void
}
/** Fetches one CDN object, or `range` ([offset, length]) of it; nothing on any failure. */
export type CascCdnFetch = (url: string, signal?: AbortSignal, range?: readonly [number, number]) => Promise<Uint8Array | undefined>
/** Where on the CDN a file the install lacks lives: its archive and byte range. */
export interface CascCdnArchives {
  locate(encodingKey: string, signal?: AbortSignal): Promise<{ readonly archive: string; readonly offset: number; readonly size: number } | undefined>
}
/** Downloaded CDN containers (BLTE bytes) by encoding key, kept between windows. */
export interface CascCdnCache {
  load(encodingKey: string): Promise<Uint8Array | undefined>
  store(encodingKey: string, bytes: Uint8Array): Promise<void>
}
export interface CascReaderOptions {
  readonly installRoot?: string
  /** `rootCache` may be chosen per game: a function of the `.build.info` product. */
  readonly rootCache?: CascRootCache | ((product: string) => CascRootCache | undefined)
  /** Turns on reading files the install does not hold from the CDN `.build.info` names. */
  readonly cdnFetch?: CascCdnFetch
  readonly cdnArchives?: (install: { readonly source: CascFileSource; readonly dataRoot: string; readonly cdnKey: string }) => CascCdnArchives
  readonly cdnCache?: CascCdnCache
  /** WoW: the listfile (`id;path` lines) that names the files of the root; `id` changes with its bytes. */
  readonly wowListfile?: { readonly id: string; load(): Promise<Uint8Array> }
  /** TACT keys by key name (16 lower-case hex digits) for encrypted BLTE blocks. */
  readonly encryptionKeys?: ReadonlyMap<string, Uint8Array>
  /** The product to open where one folder holds several (`wow`, `wow_classic`…); the active row without it. */
  readonly product?: string
  /** Most names the root may hold (4 000 000 by default). */
  readonly maxEntries?: number
}
export class CascReader {
  static open(source: CascFileSource, options?: CascReaderOptions): Promise<CascReader>
  readonly entryIndex: CascEntryIndex
  /** One byte per `entryIndex` row, 1 where the file's bytes are in the local data files. */
  localRows(): Promise<Uint8Array>
  /** One root-index row's local availability, without scanning other rows or fetching CDN bytes. */
  localRow(row: number): boolean
  contentSizeOf(path: string): number | undefined
  readPath(path: string, signal?: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}
/** One `.build.info` row; the active one names the build (`buildKey`) and the game. */
export interface CascBuild {
  readonly buildKey: string
  readonly version: string
  readonly product: string
  readonly active: boolean
  readonly fields: ReadonlyMap<string, string>
}
export function parseBuildInfo(text: string): readonly CascBuild[]
/** `product` picks one of several active products in one folder (WoW retail, classic, PTR). */
export function getActiveBuild(records: readonly CascBuild[], product?: string): CascBuild
/** The product code (`s2`, `d3`…), also for installs whose `Product` column is empty. */
export function cascProductOf(build: CascBuild): string
/** A CASC config file (`key = value` lines). */
export function parseConfig(text: string): { readonly values: ReadonlyMap<string, string>; get(name: string): string | undefined }
/** Blizzard's CDN over `fetch`, with a timeout; `range` reads one file of an archive. */
export const cdnFetch: CascCdnFetch
