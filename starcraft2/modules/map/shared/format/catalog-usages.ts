/**
 * The catalog entities a map document names — its placed objects (`Objects`) and its preload list
 * (`Preload.xml`) — as usages an entity can list: who names it, by which attribute. Read through
 * the formats' own parsers and link tables, the same ones rename and the link index use.
 */
import { getObjectEntityLinks, readObjects } from './formats/objects.js'
import { PRELOAD_TAG_LINKS, readPreload } from './formats/preload.js'

/** The link tables themselves, for readers that need positions (the cross-language link index). */
export { OBJECT_CATALOG_ATTRIBUTES } from './formats/objects.js'
export { PRELOAD_TAG_LINKS } from './formats/preload.js'

export interface MapCatalogUsage {
  /** The map document kind that names the entity: `Objects` or `Preload`. */
  readonly document: 'Objects' | 'Preload'
  /** The naming element inside it: `unit/12`, `point/3`, `Unit/Marine`. */
  readonly owner: string
  /** The attribute that holds the name: `unitType`, `texLink`, `sound`, `id`, … */
  readonly role: string
  readonly namespace: string
  readonly entityId: string
}

const baseName = (path: string): string => path.slice(path.replace(/\\/gu, '/').lastIndexOf('/') + 1).toLowerCase()

/** The map document a path names, if it is one that names catalog entities. */
export function mapCatalogUsageDocument(path: string): MapCatalogUsage['document'] | undefined {
  const name = baseName(path)
  return name === 'objects' ? 'Objects' : name === 'preload.xml' ? 'Preload' : undefined
}

export function mapCatalogUsages(path: string, text: string): readonly MapCatalogUsage[] {
  const document = mapCatalogUsageDocument(path)
  if (document === 'Objects') {
    return getObjectEntityLinks(readObjects(text)).map(link => ({
      document,
      owner: `${link.elementType}/${link.id}`,
      role: link.field,
      namespace: link.namespace,
      entityId: link.value,
    }))
  }
  if (document === 'Preload') {
    return readPreload(text).entries.flatMap(entry => {
      const link = PRELOAD_TAG_LINKS.get(entry.tag)
      const entityId = link === undefined ? undefined : entry.attrs[link.attr]
      return link === undefined || !entityId
        ? []
        : [{ document, owner: `${entry.tag}/${entityId}`, role: link.attr, namespace: link.namespace, entityId }]
    })
  }
  return []
}
