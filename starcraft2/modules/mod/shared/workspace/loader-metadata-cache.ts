/**
 * SC2 Mod loader's recoverable metadata retention, owned by modules/mod/shared/workspace.
 * Chains, layer-file tables, source directory listings and Resources share this promise/LRU policy; it
 * performs no parsing, storage reads, writes or wire serialization. Entry count bounds retained
 * pending promises; caller accounting bounds UTF-16 names/slots, not heap/RSS or active work.
 * Eviction/clear never cancel a caller's promise or mutate a delivered value. Optional onForget
 * synchronously detaches owner retention without clearing pending state. Failed, oversized and
 * invalidated reads remain retryable; late settlement cannot delete a replacement entry.
 * Internal adapter only: no new public API, persistence, source identity or loader path.
 */
interface Entry<T> { readonly promise: Promise<T>; readonly onForget?: () => void; weight: number }

/** Keep only reconstructable metadata; active callers own their already-delivered results. */
export class LoaderMetadataCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private retainedWeight = 0

  constructor(
    private readonly maximumEntries: number,
    private readonly maximumWeight: number,
    private readonly weightOf: (value: T) => number,
  ) {}

  /** Release retention; old pending reads still settle for their original callers. */
  clear(): void {
    for (const [key, entry] of this.entries) this.remove(key, entry)
    this.retainedWeight = 0
  }

  /** A late dependent operation may forget only its own retained promise generation. */
  delete(key: string, expected: Promise<T>): void {
    const entry = this.entries.get(key)
    if (entry?.promise === expected) this.remove(key, entry)
  }

  /** Forget one reader's namespace without evicting its unchanged siblings. */
  deletePrefix(prefix: string): void {
    for (const [key, entry] of this.entries) if (key.startsWith(prefix)) this.remove(key, entry)
  }

  /** Remove only the exact generation being accounted. */
  private remove(key: string, entry: Entry<T>): void {
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    this.retainedWeight -= entry.weight
    entry.onForget?.()
  }

  /** Trim recoverable promises/results in least-recently-used order. */
  private trim(): void {
    while (this.entries.size > this.maximumEntries || this.retainedWeight > this.maximumWeight) {
      const oldest = this.entries.entries().next().value
      if (oldest === undefined) break
      this.remove(oldest[0], oldest[1])
    }
  }

  /** Share an admitted read; optional cleanup detaches retention without cancelling active work. */
  get(key: string, load: () => Promise<T>, onForget?: () => void): Promise<T> {
    const known = this.entries.get(key)
    if (known !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, known)
      return known.promise
    }
    const entry: Entry<T> = { weight: 0, ...(onForget === undefined ? {} : { onForget }), promise: load().then(value => {
      if (this.entries.get(key) === entry) {
        entry.weight = key.length * 2 + this.weightOf(value)
        this.retainedWeight += entry.weight
        if (entry.weight > this.maximumWeight) this.remove(key, entry)
        else this.trim()
      }
      return value
    }).catch(error => { this.remove(key, entry); throw error }) }
    this.entries.set(key, entry)
    this.trim()
    // Preserve the old memo's rejection observation even if a caller awaits another read first.
    void entry.promise.catch(() => {})
    return entry.promise
  }
}
