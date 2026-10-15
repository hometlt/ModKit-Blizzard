import type { SC2LayoutFile } from '../layout-engine/sc2-layout-core/simple-parse/index.js'
import { CATALOG_NAMESPACES } from '../../../data/shared/catalog-engine/sc2-schema/index.js'

export type Sc2LayoutReferenceKind = 'string' | 'asset' | 'style' | 'sound' | 'catalog'

export interface Sc2LayoutReference {
  readonly file: string
  readonly frame: string
  readonly property: string
  readonly raw: string
  readonly prefix: '@' | '@@'
  readonly key: string
  readonly namespace: string
  readonly kind: Sc2LayoutReferenceKind
  readonly to?: { readonly namespace: string; readonly id: string }
}

/** Minimal resolved workspace view needed for layout relation discovery. */
export interface Sc2LayoutRelationSource {
  readonly layouts?: ReadonlyMap<string, SC2LayoutFile>
  get(namespace: string, id: string): { namespace: string; id: string } | undefined
  namespaces(): readonly string[]
}

const ASSET_PROPERTIES = new Set([
  'texture',
  'file',
  'image',
  'backgroundimage',
  'borderimage',
  'hoverimage',
  'normalimage',
  'pushedimage',
  'disabledimage',
  'checkedimage',
  'uncheckedimage',
  'alphamask',
  'alphalayer',
  'iconimage',
])
const SOUND_PROPERTIES = new Set([
  'clicksound',
  'mousedownsound',
  'mouseentersound',
  'mouseexitsound',
  'hoversound',
  'sound',
])
const STRING_PROPERTIES = new Set([
  'text',
  'tooltip',
  'tooltiptext',
  'shortcut',
  'hotkey',
  'label',
  'edittext',
])

function classifyProperty(property: string): Sc2LayoutReferenceKind {
  const normalized = property.toLowerCase()
  if (normalized === 'style') return 'style'
  if (SOUND_PROPERTIES.has(normalized) || normalized.endsWith('sound')) return 'sound'
  if (ASSET_PROPERTIES.has(normalized) || normalized.endsWith('image')) return 'asset'
  if (STRING_PROPERTIES.has(normalized)) return 'string'
  return 'string'
}

export function buildSc2LayoutReferences(source: Sc2LayoutRelationSource): Sc2LayoutReference[] {
  const canonicalNamespaces = new Map<string, string>()
  for (const namespace of CATALOG_NAMESPACES) {
    canonicalNamespaces.set(namespace.toLowerCase(), namespace)
  }
  for (const namespace of source.namespaces()) {
    canonicalNamespaces.set(namespace.toLowerCase(), namespace)
  }

  const output: Sc2LayoutReference[] = []
  for (const [file, layout] of source.layouts ?? new Map<string, SC2LayoutFile>()) {
    for (const reference of layout.references) {
      const resolved = resolveCatalogReference(source, canonicalNamespaces, reference.value)
      output.push({
        file,
        frame: reference.frame,
        property: reference.property,
        raw: reference.raw,
        prefix: reference.prefix,
        key: reference.value,
        namespace: reference.namespace,
        kind: resolved === undefined ? classifyProperty(reference.property) : 'catalog',
        ...(resolved === undefined ? {} : { to: resolved }),
      })
    }
  }
  return output
}

function resolveCatalogReference(
  source: Sc2LayoutRelationSource,
  canonicalNamespaces: ReadonlyMap<string, string>,
  key: string,
): { namespace: string; id: string } | undefined {
  const segments = key.split('/')
  if (segments.length < 2) return undefined
  const namespace = canonicalNamespaces.get((segments[0] ?? '').toLowerCase())
  const id = segments.at(-1) ?? ''
  if (!namespace || !id) return undefined
  return source.get(namespace, id) === undefined ? undefined : { namespace, id }
}
