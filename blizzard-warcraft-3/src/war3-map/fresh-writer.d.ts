/**
 * Types of `@modkit/blizzard-mpq/fresh-writer`, which [Blizzard] Formats publishes as JS without
 * declarations; only the one function the map encoder calls. Remove when the package declares it.
 */
declare module '@modkit/blizzard-mpq/fresh-writer' {
  /** A deterministic MPQ v0 with uncompressed, unencrypted single-unit files and a listfile. */
  export function encodeFreshMpq(
    entries: readonly { readonly path: string; readonly bytes: Uint8Array }[],
    maximumBytes?: number,
    options?: { readonly signal?: AbortSignal },
  ): Uint8Array
}
