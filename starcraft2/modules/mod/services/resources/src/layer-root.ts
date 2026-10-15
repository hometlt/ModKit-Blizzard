/**
 * Native layer identities shared by context loading and the resource tree. This module maps a
 * layer to its existing Host/VFS address; it loads no resource parsers or game models.
 */
import { pathToFileURL } from 'node:url'
import type { AssetSourceRef } from '@modkit/sdk'
import type { Sc2ModContextLayer } from '../../../shared/workspace/mod-contexts.js'

/** Keep the same identity for a host folder and for a member of a content source. */
export function layerRoot(layer: Pick<Sc2ModContextLayer, 'sourceId' | 'sourcePath'>): AssetSourceRef {
  const uri = layer.sourceId === 'host'
    ? pathToFileURL(layer.sourcePath).href
    : `modkit-source://battlenet/${[layer.sourceId, ...layer.sourcePath.split('/')]
        .map(encodeURIComponent).join('/')}`
  return { id: uri, uri }
}
