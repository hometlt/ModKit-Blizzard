export interface ByteDocumentSourceDescriptorInit {
  readonly id: string
  readonly path: string
}

export interface ByteDocumentSourceDescriptor {
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: 'file'
  readonly origin: 'memory'
  readonly path: string
  readonly name: string
  readonly extension: string
  readonly size: number
  readonly readOnly: true
  readonly randomAccess: true
  readonly seekable: true
}

export function byteDocumentSourceDescriptor(
  bytes: Uint8Array,
  init: ByteDocumentSourceDescriptorInit,
): ByteDocumentSourceDescriptor
