export type WarcraftModelFormat = 'mdx' | 'mdl'

const textDecoder = new TextDecoder('ascii')

export function isWar3MdxBinary(bytes: Uint8Array): boolean {
  return textDecoder.decode(bytes.subarray(0, 4)) === 'MDLX'
}

export function isWar3MdlText(bytes: Uint8Array): boolean {
  const prefix = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 32)))
  return /^\s*Version\s*\{/.test(prefix)
}

/**
 * Canonical name the generated eager detector barrel imports. Exporting it is how a codec opts
 * into synchronous detection without the consuming package linking anything by hand.
 *
 * A wrapper rather than an alias because this codec owns two variants of one format — the binary
 * `MDLX` container and its text serialisation — and either identifies it. That is also why its
 * manifest declares no `match.magic`: the prefilter is conjunctive, so a declared `MDLX` signature
 * would reject every text file this codec is meant to read.
 */
export function detectHeader(bytes: Uint8Array): boolean {
  return isWar3MdxBinary(bytes) || isWar3MdlText(bytes)
}

export function detectWar3ModelFormat(
  bytes: Uint8Array,
  hint = '',
): WarcraftModelFormat | 'unknown' {
  const normalizedHint = hint.replace(/\\/g, '/').toLowerCase()
  if (/\.mdx$/i.test(normalizedHint)) return 'mdx'
  if (/\.mdl$/i.test(normalizedHint)) return 'mdl'
  if (isWar3MdxBinary(bytes)) return 'mdx'
  if (isWar3MdlText(bytes)) return 'mdl'
  return 'unknown'
}
