import { getConfig } from '../config.js'
import { getFs, getPath } from '../platform.js'
import type { M3Section, M3Reference, SectionResolver } from '../types.js'

const SLASH_RE = /\\/g

/** Resolve an M3 texture path to a local filesystem or URL path. */
export function resolveTexturePath(
  m3Path: string | null,
  textureBasePath: string | null,
): string | null {
  if (!m3Path || !textureBasePath) return null
  const lastSlash = m3Path.lastIndexOf('\\')
  const filename =
    lastSlash >= 0 ? m3Path.slice(lastSlash + 1) : m3Path.slice(m3Path.lastIndexOf('/') + 1)
  if (!filename) return null
  if (getConfig().isNode) {
    return getPath().join(textureBasePath, filename)
  }
  return `${textureBasePath}/${filename}`
}

/** Read a string from a CHAR section referenced by a Reference field. */
export function getSectionString(sections: SectionResolver, reference: M3Reference | null): string {
  const sec = sections.getSectionByReference(reference)
  if (!sec) return ''
  const content = sec.content as number[]
  let len = content.length
  while (len > 0 && content[len - 1] === 0) len-- // trim trailing nulls
  return String.fromCharCode.apply(null, content.slice(0, len) as unknown as number[])
}

/** Check whether a texture file exists on disk (Node.js only). */
export function textureExists(texPath: string): boolean {
  if (!getConfig().isNode) return false
  try {
    return getFs().existsSync(texPath)
  } catch {
    return false
  }
}
