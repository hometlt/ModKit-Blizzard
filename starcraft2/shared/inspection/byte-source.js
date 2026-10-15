function nonBlank(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

/**
 * Serializable source projection for bytes already owned by an MK3 inspection session.
 *
 * This has no read methods and does not create a second source. It only supplies the stable
 * identity and path metadata still consumed by ported format engines while their DTOs migrate.
 */
export function byteDocumentSourceDescriptor(bytes, init) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('document bytes must be Uint8Array')
  const id = nonBlank(init?.id, 'source id')
  const path = nonBlank(init?.path, 'source path').replace(/\\/gu, '/')
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot).toLowerCase()
  return Object.freeze({
    schemaVersion: 1,
    id,
    kind: 'file',
    origin: 'memory',
    path,
    name,
    extension,
    size: bytes.byteLength,
    readOnly: true,
    randomAccess: true,
    seekable: true,
  })
}
