/**
 * JSON mod format — a self-contained JSON representation of a mod's catalog: per namespace, each
 * entity's raw fields plus its `class` (when not the namespace's base class) and `parent`, with a
 * top-level `deps` list and a `manifest`. `export.convert` writes it (`exportJsonMod`); this module
 * reads it back.
 *
 * `jsonModToFiles(jsonMod)` synthesizes the SC2Components layout (GameData `<Catalog>` XML,
 * DocumentInfo, ComponentList). `jsonModContentSource` serves JSON mods as a content source, so the
 * one mod loader opens one — or resolves one as a dependency — exactly like a folder mod.
 */

import type { RawFields } from '../../data/shared/catalog-engine/xml/index.js'
import { entityToXml, constEntryToXml } from '../../data/shared/format/entity-xml.js'
import { writeSc2DocumentInfoDependencies } from '../codecs/document-metadata/dependencies.js'
import type { ContentSourceStorage } from './workspace/content-source-provider.js'

export const JSON_MOD_FORMAT = 'modkit-json-mod@1'

/** A single entity in a JSON mod: reserved `class`/`parent` keys + raw fields. */
export interface JsonModEntity {
  /** C-prefixed class, present only when it differs from the base class `C<ns>`. */
  class?: string
  /** Parent id for inheritance, when set. */
  parent?: string
  /** Remaining raw fields (anything that isn't `class`/`parent`). */
  [field: string]: unknown
}

export interface JsonMod {
  manifest: { format: string; name?: string }
  /** Ordered dependency mod names (resolved via the source chain), e.g. ["Liberty.SC2Mod"]. */
  deps: string[]
  /** namespace → id → entity. */
  entries: Record<string, Record<string, JsonModEntity>>
}

export interface JsonModWritableFile {
  path: string
  content: string | Uint8Array
}

/** Map namespace → SC2 data file name (lowercase + "data.xml"), as the editor uses. */
function nsToFileName(ns: string): string {
  return `${ns.toLowerCase()}data.xml`
}

/** Split an entity object into its structural attrs and its raw data fields. */
function splitEntity(entity: JsonModEntity): {
  cls: string | undefined
  parent: string | undefined
  data: RawFields
} {
  const { class: cls, parent, ...rest } = entity
  return { cls, parent, data: rest as RawFields }
}

/**
 * Synthesize the SC2Components file layout for a JSON mod: one GameData `<Catalog>`
 * XML per namespace (+ a `DocumentInfo` declaring deps, + a `ComponentList`). Paths
 * are relative to the mod root, matching `exportSc2Components`.
 */
export function jsonModToFiles(jsonMod: JsonMod, indent = '    '): JsonModWritableFile[] {
  const files: JsonModWritableFile[] = []

  for (const [ns, byId] of Object.entries(jsonMod.entries)) {
    const ids = Object.keys(byId)
    if (ids.length === 0) continue

    const xmlLines: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Catalog>']
    for (const id of ids) {
      const { cls, parent, data } = splitEntity(byId[id]!)
      if (ns === 'Const') {
        const type = typeof data['type'] === 'string' ? data['type'] : ''
        const value = typeof data['value'] === 'string' ? data['value'] : ''
        xmlLines.push(constEntryToXml(id, type as string, value as string, indent))
      } else {
        const className = cls ?? `C${ns}`
        xmlLines.push(
          entityToXml(className, id, parent, data, id === '', { indent, writeDefaultAttr: true }),
        )
      }
    }
    xmlLines.push('</Catalog>')

    files.push({
      path: `base.sc2data/GameData/${nsToFileName(ns)}`,
      content: xmlLines.join('\n') + '\n',
    })
  }

  if (jsonMod.deps.length > 0) {
    files.push({ path: 'DocumentInfo', content: buildDocumentInfo(jsonMod.deps) })
  }
  files.push({ path: 'ComponentList.SC2Components', content: buildComponentList() })

  return files
}

function buildDocumentInfo(deps: string[]): Uint8Array {
  const values = deps.map(dep => {
    const name = /\.(sc2mod|sc2map|sc2campaign)$/i.test(dep) ? dep : `${dep}.SC2Mod`
    return `file:Mods\\${name}`
  })
  return writeSc2DocumentInfoDependencies(values)
}

function buildComponentList(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Components>',
    '    <DataComponent Type="gada">GameData</DataComponent>',
    '    <DataComponent Type="info">DocumentInfo</DataComponent>',
    '</Components>',
    '',
  ].join('\n')
}

/** Read a JSON mod, refusing anything that does not name this format. */
export function parseJsonMod(text: string): JsonMod {
  const value = JSON.parse(text) as Partial<JsonMod> | null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('a JSON mod must be an object')
  }
  if (value.manifest?.format !== JSON_MOD_FORMAT) {
    throw new TypeError(`a JSON mod must declare manifest.format "${JSON_MOD_FORMAT}"`)
  }
  if (!Array.isArray(value.deps) || !value.deps.every(dep => typeof dep === 'string')) {
    throw new TypeError('a JSON mod must list its deps as strings')
  }
  const entries = value.entries
  if (
    entries === null ||
    typeof entries !== 'object' ||
    Array.isArray(entries) ||
    !Object.values(entries).every(
      byId => byId !== null && typeof byId === 'object' && !Array.isArray(byId),
    )
  ) {
    throw new TypeError('a JSON mod must map namespaces to entities by id')
  }
  return value as JsonMod
}

/** The package folder a JSON mod is served as: its manifest name (or key), `.SC2Mod` unless named. */
function rootName(key: string, jsonMod: JsonMod): string {
  const explicit = jsonMod.manifest.name ?? key
  return /\.(sc2mod|sc2map|sc2campaign)$/i.test(explicit) ? explicit : `${explicit}.SC2Mod`
}

/**
 * JSON mods as a content source: each under `Mods/<name>.SC2Mod`, holding the files
 * `jsonModToFiles` synthesizes. Paths are case-insensitive, as in every StarCraft II storage.
 */
export function jsonModContentSource(
  id: string,
  mods: ReadonlyMap<string, JsonMod>,
): ContentSourceStorage {
  const files = new Map<string, { readonly path: string; readonly bytes: Uint8Array }>()
  const encoder = new TextEncoder()
  for (const [key, jsonMod] of mods) {
    const root = `Mods/${rootName(key, jsonMod)}`
    for (const file of jsonModToFiles(jsonMod)) {
      const path = `${root}/${file.path}`
      const bytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content
      files.set(path.toLowerCase(), { path, bytes })
    }
  }
  const fold = (path: string): string => path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '').toLowerCase()
  return Object.freeze({
    id,
    async list(folder: string) {
      const prefix = fold(folder) === '' ? '' : `${fold(folder)}/`
      const children = new Map<string, { name: string; directory: boolean; size?: number }>()
      for (const [key, file] of files) {
        if (!key.startsWith(prefix)) continue
        const rest = file.path.slice(prefix.length)
        const name = rest.split('/')[0] as string
        const directory = rest.includes('/')
        children.set(name.toLowerCase(), directory ? { name, directory } : { name, directory, size: file.bytes.byteLength })
      }
      if (children.size === 0 && prefix !== '') throw new Error(`${folder} is not in ${id}`)
      return [...children.values()]
    },
    async read(path: string, maxBytes: number) {
      const file = files.get(fold(path))
      if (file === undefined) throw new Error(`${path} is not in ${id}`)
      if (file.bytes.byteLength > maxBytes) throw new RangeError(`${path} exceeds ${maxBytes} bytes`)
      return file.bytes
    },
  })
}
