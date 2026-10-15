export const CASC_LIMITS = Object.freeze({
  // Battle.net keeps superseded .idx versions beside data.NNN; a repaired SC2 install listed 197
  // entries in SC2Data/data (165 indexes). Only the newest index per bucket is read.
  maxListEntries: 4096,
  maxIndexFiles: 64,
  maxIndexBytes: 64 * 1024 * 1024,
  maxWholeFileBytes: 64 * 1024 * 1024,
  // As much as one decode may produce: Heroes of the Storm's encoding table is 92.5 MB on its own.
  maxContainerReadBytes: 128 * 1024 * 1024,
  maxHostReadBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
  maxExtractBytes: 128 * 1024 * 1024,
  // World of Warcraft 12 lists 3.3 million files, Heroes of the Storm 1.21 million (SC2 ~600 000);
  // the path index keeps ~30 bytes a file.
  maxEntries: 4_000_000,
  maxPageItems: 256,
  maxSearchBasenames: 16,
  maxPathBytes: 4096,
})

export function cascError(code, message, context = {}) {
  return Object.assign(new Error(message), { code, context: Object.freeze({ ...context }) })
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}
