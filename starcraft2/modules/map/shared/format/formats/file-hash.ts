/**
 * Parser and writer for the `FileHash` file embedded in `.SC2Map` archives.
 *
 * Format: a 64-byte SHA-512 hash of the archive's content. Written by the
 * SC2 Editor on save; the game engine reads it as an integrity check.
 *
 * There is no header or version field — the file is exactly 64 bytes (raw
 * binary hash). The writer simply returns whatever 64-byte hash is stored in
 * the result struct.
 *
 * Note: modkitx does NOT recompute the hash automatically. When you repack a
 * map after making changes, either call `computeFileHash` to regenerate it, or
 * omit the `FileHash` file from the repacked archive (the game will accept
 * archives without it).
 *
 * Browser-safe: pure Uint8Array operations, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileHashResult {
  /**
   * The raw 64-byte SHA-512 hash. May be fewer bytes on malformed files (the
   * codec never throws for a short read — it just returns what it has).
   */
  hash: Uint8Array
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse (read) a `FileHash` file — just wraps the bytes. */
export function readFileHash(bytes: Uint8Array): FileHashResult {
  return { hash: bytes.slice(0, 64) }
}

/** Serialize a `FileHashResult` back to its binary form. */
export function writeFileHash(data: FileHashResult): Uint8Array {
  const out = new Uint8Array(64)
  out.set(data.hash.slice(0, 64))
  return out
}

/**
 * Convert the hash bytes to a lowercase hex string for display / comparison.
 *
 * Example:
 * ```ts
 * const hex = fileHashToHex(data.fileHash!.hash)
 * // → "3d4f…" (128 hex characters)
 * ```
 */
export function fileHashToHex(hash: Uint8Array): string {
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
