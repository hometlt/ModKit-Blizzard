import type { Sc2LayoutDocument } from './document.js'
import { renameSc2LayoutReferences, type Sc2LayoutRenameOptions } from './rename.js'

export interface Sc2LayoutReferenceRenameResult {
  readonly bytes: Uint8Array
  readonly referencesPatched: number
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function encodeLikeSource(document: Sc2LayoutDocument, text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  if (!hasUtf8Bom(document.bytes)) return body
  const output = new Uint8Array(body.byteLength + 3)
  output.set([0xef, 0xbb, 0xbf])
  output.set(body, 3)
  return output
}

/** Pure byte-preserving transform shared by the MK3 codec and the legacy transaction oracle. */
export function renameSc2LayoutReferenceBytes(
  document: Sc2LayoutDocument,
  options: Sc2LayoutRenameOptions,
): Sc2LayoutReferenceRenameResult {
  const renamed = renameSc2LayoutReferences(document.text, options)
  return {
    bytes: encodeLikeSource(document, renamed.xml),
    referencesPatched: renamed.patched,
  }
}
