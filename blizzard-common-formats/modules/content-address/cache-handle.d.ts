export interface BlizzardCacheHandle {
  readonly type: string
  readonly region: string
  readonly sha256: string
  readonly file: string
}

/** `types`: the type tags accepted (default: map files, `/^s2m[a-z]$/`); a tag is always 4 letters or digits. */
export function decodeBlizzardCacheHandle(bytes: Uint8Array, options?: { readonly types?: RegExp }): BlizzardCacheHandle | undefined
