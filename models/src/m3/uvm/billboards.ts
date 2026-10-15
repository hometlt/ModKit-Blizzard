import type { JsonObject, ModelBoneBinding } from '@modkit/sdk'
import type { UvmContainer } from '@modkit/uv/model/container'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { M3_BILLBOARD } from '../skeleton-projection.js'
interface M3Billboard {
  readonly nodeId: string
}
/** Capture before conversion's first await; preserve nativeFlags, interpret only pinned bit0x10. */
export function captureM3Billboards(
  bindings: readonly ModelBoneBinding[],
  maxNodes: number,
  maxBytes: number,
  signal?: AbortSignal,
): readonly M3Billboard[] {
  signal?.throwIfAborted()
  if (bindings.length > maxNodes || bindings.length * 128 > maxBytes)
    throw new RangeError('M3 billboard bindings exceed budget')
  const captured: M3Billboard[] = []
  for (const bone of bindings) {
    signal?.throwIfAborted()
    const flags = bone.nativeFlags ?? 0
    if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffffffff)
      throw new TypeError('M3 billboard flags invalid')
    if ((flags & 0x10) === 0) continue
    if (bone.nodeId === undefined)
      throw new TypeError('M3 billboard bone has no portable node binding')
    captured.push({ nodeId: bone.nodeId })
  }
  return snapshotJson(
    captured,
    { maxNodes, maxBytes, maxDepth: 8 },
    signal,
  ) as unknown as readonly M3Billboard[]
}
export function addM3Billboards(
  container: UvmContainer,
  bindings: readonly M3Billboard[],
  nodes: Readonly<Record<string, number>>,
  maxNodes: number,
  maxBytes: number,
  signal?: AbortSignal,
): UvmContainer {
  signal?.throwIfAborted()
  if (bindings.length === 0) return container
  const source = container.document['nodes']
  if (!Array.isArray(source)) throw new TypeError('M3 billboard nodes absent')
  if (
    !Number.isSafeInteger(maxNodes) ||
    !Number.isSafeInteger(maxBytes) ||
    source.length > maxNodes ||
    source.length * 16 + bindings.length * 512 > maxBytes
  )
    throw new RangeError('M3 billboard node projection exceeds budget')
  const byNode = new Set<number>()
  for (const binding of bindings) {
    signal?.throwIfAborted()
    const index = nodes[binding.nodeId]
    if (
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= source.length ||
      byNode.has(index)
    )
      throw new TypeError('M3 billboard node mapping invalid')
    byNode.add(index)
  }
  // Pinned quatFromAxisAngle([0,0,1],+pi/2), then ([0,1,0],-pi/2): the same rule the scene nodes
  // state. ponytail: the core materializer writes it from them; this patch covers a vendored one
  // older than that and goes with the hop that brings it.
  const basisRotations = M3_BILLBOARD.basisRotations.map(rotation => [...rotation])
  return {
    ...container,
    document: {
      ...container.document,
      extensionsUsed: [
        ...new Set([
          ...((container.document['extensionsUsed'] as string[]) ?? []),
          'UV_node_billboard',
        ]),
      ],
      nodes: source.map((raw, index) => {
        signal?.throwIfAborted()
        if (!byNode.has(index)) return raw
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
          throw new TypeError('M3 billboard node invalid')
        const node = raw as JsonObject,
          extensions = node['extensions'] ?? {}
        if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions))
          throw new TypeError('M3 billboard node extensions invalid')
        return {
          ...node,
          extensions: {
            ...extensions,
            UV_node_billboard: {
              schemaVersion: 1,
              mode: 'inverse-camera',
              basisRotations,
            },
          },
        }
      }),
    },
  }
}
