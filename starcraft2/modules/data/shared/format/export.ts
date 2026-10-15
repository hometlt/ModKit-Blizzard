/**
 * `sc2-data`'s `export.convert` surface: catalog/entity-level export (Phase D item 3).
 *
 * Moved here from `@modkitx/export`:
 *
 * - `exportJson` → {@link exportCatalogJson}: resolved-or-raw entity fields, one object per
 *   namespace keyed by entity id. Pure catalog semantics (inheritance merge, token substitution,
 *   default-entity diffing) — nothing mod-shaped.
 * - the per-namespace `<Catalog>` XML emission that `exportSc2Components` used to inline →
 *   {@link catalogNamespaceXml} / {@link catalogNamespaceFileName}, built on
 *   `./entity-xml.js`'s `entityToXml`/`constEntryToXml`.
 *
 * Mod-level SC2Components/JSON export now lives in `sc2-mod`; JSON-mod tree synthesis and
 * reading live in `mod-workspace`. `@modkitx/export` remains a compatibility facade.
 *
 * {@link exportCatalogOutputs} is the `RenameOutput`-shaped wrapper the codec operation dispatches
 * to, so a host gets bytes + media types without knowing which function produced them.
 */

import {
  Sc2EditInputError,
  type RenameOutput,
} from '../../../../shared/editing/rename-transaction.js'
import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'
import type { RawFields } from '../catalog-engine/xml/index.js'
import { constEntryToXml, entityToXml } from './entity-xml.js'
import { SC2_DATA_CODEC_ID } from './identity.js'

/**
 * The minimal catalog store the exporters need. `@modkitx/mods-processing/sc2-mod-core`'s `SC2Mod` and
 * `@modkitx/data-processing/sc2-catalog`'s `TypedCatalog` both satisfy it structurally.
 */
export interface CatalogExportStore {
  namespaces(): string[]
  all(namespace: string): CatalogEntity[]
  getResolved(namespace: string, id: string): RawFields | undefined
}

/** Options shared by the catalog exporters. */
export interface CatalogExportOptions {
  /** Which namespaces to include. Default: every namespace present in the store. */
  namespaces?: string[]
}

export interface CatalogJsonExportOptions extends CatalogExportOptions {
  /**
   * 'full'  — every field, including inherited defaults (resolved chain).
   * 'raw'   — only fields explicitly defined on each entity (no inheritance).
   * Default: 'full'
   */
  mode?: 'full' | 'raw'
  /**
   * Omit fields whose resolved value equals the default entity's value.
   * Only applies when mode='full'. Produces smaller output similar to json-mini.
   * Default: false
   */
  omitDefaults?: boolean
}

export interface CatalogXmlExportOptions extends CatalogExportOptions {
  /** Write a `default="1"` attribute on the default entity (id=""). Default: true. */
  writeDefaultAttr?: boolean
  /** Indentation string for XML output. Default: four spaces. */
  indent?: string
}

/**
 * Export catalog entities to JSON — one object per namespace, keyed by entity id.
 *
 * mode='full'  (default): resolved fields (parent chain applied, tokens substituted).
 * mode='raw':             only fields explicitly set on each entity.
 *
 * Returns a plain JS object; the caller serialises with `JSON.stringify`.
 */
export function exportCatalogJson(
  store: CatalogExportStore,
  options: CatalogJsonExportOptions = {},
): Record<string, Record<string, unknown>> {
  const { mode = 'full', omitDefaults = false, namespaces } = options

  const nsList = namespaces ?? store.namespaces()
  const result: Record<string, Record<string, unknown>> = {}

  for (const ns of nsList) {
    const entities = store.all(ns)
    if (entities.length === 0) continue

    const baseClass = `C${ns}`
    const nsOut: Record<string, unknown> = {}

    // Pre-compute default entity fields for omitDefaults
    const defaultResolved =
      omitDefaults && mode === 'full' ? (store.getResolved(ns, '') ?? {}) : undefined

    for (const entity of entities) {
      const fields = mode === 'full' ? (store.getResolved(ns, entity.id) ?? {}) : entity.data

      let out: Record<string, unknown> = { ...fields }

      if (defaultResolved !== undefined && entity.id !== '') {
        // Remove fields that equal the default value
        for (const key of Object.keys(out)) {
          if (JSON.stringify(out[key]) === JSON.stringify(defaultResolved[key])) {
            delete out[key]
          }
        }
      }

      // Include class only when it differs from the base class (e.g. CAbilEffectTarget vs CAbil)
      if (entity.class !== baseClass) {
        out = { class: entity.class, ...out }
      }

      nsOut[entity.id] = out
    }

    result[ns] = nsOut
  }

  return result
}

/** SC2 GameData file name for one namespace (SC2 convention: lowercase + "data.xml"). */
export function catalogNamespaceFileName(namespace: string): string {
  return `${namespace.toLowerCase()}data.xml`
}

/**
 * Serialize one namespace's entities as a complete `<Catalog>` GameData document.
 *
 * `Const` entries use the lowercase `<const type= value=>` form; every other namespace uses the
 * class-tagged entity element. This is the exact emission `exportSc2Components` used to inline.
 */
export function catalogNamespaceXml(
  store: CatalogExportStore,
  namespace: string,
  options: CatalogXmlExportOptions = {},
): string {
  const { writeDefaultAttr = true, indent = '    ' } = options
  const xmlLines: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Catalog>']

  for (const entity of store.all(namespace)) {
    if (namespace === 'Const') {
      const type = typeof entity.data['type'] === 'string' ? entity.data['type'] : ''
      const value = typeof entity.data['value'] === 'string' ? entity.data['value'] : ''
      xmlLines.push(constEntryToXml(entity.id, type, value, indent))
    } else {
      const isDefault = entity.id === ''
      xmlLines.push(
        entityToXml(entity.class, entity.id, entity.parent, entity.data, isDefault, {
          indent,
          writeDefaultAttr,
        }),
      )
    }
  }

  xmlLines.push('</Catalog>')
  return xmlLines.join('\n') + '\n'
}

/** JSON-serializable input accepted by `sc2-data`'s `export.convert` handler. */
export interface Sc2DataExportInput extends CatalogJsonExportOptions, CatalogXmlExportOptions {
  /** `json` (default) emits one `catalog.json`; `xml` emits one GameData file per namespace. */
  readonly format?: 'json' | 'xml'
}

function fail(message: string): never {
  throw new Sc2EditInputError(message, {
    codecId: SC2_DATA_CODEC_ID,
    operation: 'export.convert',
  })
}

/** Validates and normalizes the JSON operation input received over a session handler. */
export function parseSc2DataExportInput(input: unknown): Sc2DataExportInput {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('sc2-data export.convert input must be an object.')
  }
  const { format, mode, omitDefaults, namespaces, indent, writeDefaultAttr } = input as Record<
    string,
    unknown
  >
  if (format !== undefined && format !== 'json' && format !== 'xml') {
    fail("sc2-data export.convert `format` must be 'json' or 'xml'.")
  }
  if (mode !== undefined && mode !== 'full' && mode !== 'raw') {
    fail("sc2-data export.convert `mode` must be 'full' or 'raw'.")
  }
  if (omitDefaults !== undefined && typeof omitDefaults !== 'boolean') {
    fail('sc2-data export.convert `omitDefaults` must be a boolean.')
  }
  if (writeDefaultAttr !== undefined && typeof writeDefaultAttr !== 'boolean') {
    fail('sc2-data export.convert `writeDefaultAttr` must be a boolean.')
  }
  if (indent !== undefined && typeof indent !== 'string') {
    fail('sc2-data export.convert `indent` must be a string.')
  }
  if (
    namespaces !== undefined &&
    (!Array.isArray(namespaces) || namespaces.some(item => typeof item !== 'string'))
  ) {
    fail('sc2-data export.convert `namespaces` must be an array of strings.')
  }
  return {
    ...(format === undefined ? {} : { format }),
    ...(mode === undefined ? {} : { mode }),
    ...(omitDefaults === undefined ? {} : { omitDefaults }),
    ...(writeDefaultAttr === undefined ? {} : { writeDefaultAttr }),
    ...(indent === undefined ? {} : { indent }),
    ...(namespaces === undefined ? {} : { namespaces: [...(namespaces as string[])] }),
  }
}

/**
 * The `export.convert` operation body: catalog export rendered as `RenameOutput`s.
 *
 * Paths are mount-relative and deliberately carry no mod root — where a `GameData/` directory
 * lands inside an `.SC2Mod` is `sc2-mod`'s business, not the catalog's.
 */
export function exportCatalogOutputs(
  store: CatalogExportStore,
  input: Sc2DataExportInput = {},
): readonly RenameOutput[] {
  const encoder = new TextEncoder()

  if (input.format === 'xml') {
    const nsList = (input.namespaces ?? store.namespaces()).filter(ns => store.all(ns).length > 0)
    return nsList.map(ns => ({
      path: `GameData/${catalogNamespaceFileName(ns)}`,
      data: encoder.encode(catalogNamespaceXml(store, ns, input)),
      mediaType: 'application/xml',
      role: 'sc2-data',
    }))
  }

  const json = exportCatalogJson(store, input)
  return [
    {
      path: 'catalog.json',
      data: encoder.encode(JSON.stringify(json, null, 2) + '\n'),
      mediaType: 'application/json',
      role: 'sc2-data',
    },
  ]
}
