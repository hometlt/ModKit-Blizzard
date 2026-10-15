/** MK3-owned routing for map documents missing or misnamed in the frozen MK2 aggregate. */
import {
  parseMapEntries,
  readAIData,
  readCellAttribute,
  readEditorCategories,
  readPaintedPathing,
  readPreload,
  readPreloadAssetDb,
  serializeMapEntries,
  writeAIData,
  writeCellAttribute,
  writeEditorCategories,
  writePaintedPathing,
  writePreload,
  writePreloadAssetDb,
  type AIDataResult,
  type CellAttributeResult,
  type PaintedPathingResult,
  type PreloadAssetDbResult,
  type SC2MapData,
} from './format/index.js'
import { readAttributes, writeAttributes, type AttributesResult } from './format/formats/attributes.js'

const utf8 = new TextDecoder('utf-8')
const utf8Encoder = new TextEncoder()
const originalText = new WeakMap<object, Readonly<{ raw: string; normalized: string }>>()
const legacyBaseline = new WeakMap<SC2MapData, ReadonlyMap<string, Uint8Array>>()

function rememberText<T extends object>(value: T, raw: string, write: (value: T) => string): T {
  originalText.set(value, Object.freeze({ raw, normalized: write(value) }))
  return value
}

function writeTextPreserving<T extends object>(value: T, write: (value: T) => string): Uint8Array {
  const normalized = write(value)
  const original = originalText.get(value)
  return utf8Encoder.encode(original !== undefined && original.normalized === normalized ? original.raw : normalized)
}

export interface ContextualCellAttribute {
  readonly path: string
  readonly suffix: string
  readonly byteLength: number
  /** Missing means the document remains available through rawFiles but cannot be rasterized safely. */
  readonly value?: CellAttributeResult
  readonly missingContext?: 'map-dimensions'
}

export interface OpaqueXmlDocument {
  /** Exact authored XML. No semantic edit is claimed until a native schema is proven. */
  xml: string
  rootTag: string
}

export interface SC2MapDocumentData extends SC2MapData {
  cellAttributes?: Readonly<Record<string, ContextualCellAttribute>>
  paintedCreep?: PaintedPathingResult
  preloadAssetDb?: PreloadAssetDbResult
  customAi?: AIDataResult
  attributes?: AttributesResult
}

export interface ParseMapDocumentOptions {
  readonly onError?: (path: string, error: unknown) => void
}

const basename = (path: string): string => path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''

function readNamedXml(xml: string, expectedRoot: string): OpaqueXmlDocument {
  const rootTag = /<([A-Za-z_][\w:.-]*)(?:\s|>|\/>)/.exec(xml)?.[1]
  if (rootTag !== expectedRoot) throw new TypeError(`expected <${expectedRoot}> root, received ${rootTag === undefined ? 'no XML root' : `<${rootTag}>`}`)
  return { xml, rootTag }
}

function originalPath(files: ReadonlyMap<string, Uint8Array>, names: ReadonlySet<string>): string | undefined {
  return [...files.keys()].find(path => names.has(basename(path)))
}

function equalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined || left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * Compose the frozen MK2 aggregate with MK3 document routes. No input key is renamed, so
 * diagnostics and later writes retain the actual archive path selected by the user.
 */
export function parseSc2MapDocuments(
  files: Map<string, Uint8Array>,
  options: ParseMapDocumentOptions = {},
): SC2MapDocumentData {
  const data = parseMapEntries(files, options)
  const cellAttributes: Record<string, ContextualCellAttribute> = {}

  for (const [path, bytes] of files) {
    const name = basename(path)
    try {
      if (name === 'editorcategories.xml') {
        const xml = utf8.decode(bytes)
        data.editorCategories = rememberText(readEditorCategories(xml), xml, writeEditorCategories)
      } else if (name === 'preload.xml') {
        const xml = utf8.decode(bytes)
        data.preload = rememberText(readPreload(xml), xml, writePreload)
      } else if (name === 'customai') {
        const xml = utf8.decode(bytes)
        readNamedXml(xml, 'AIData')
        ;(data as SC2MapDocumentData).customAi = readAIData(xml)
      } else if (name === 'attributes') {
        const xml = utf8.decode(bytes)
        readNamedXml(xml, 'Attributes')
        ;(data as SC2MapDocumentData).attributes = readAttributes(xml)
      } else if (name === 'paintedcreeplayer') {
        ;(data as SC2MapDocumentData).paintedCreep = readPaintedPathing(bytes)
      } else if (name === 'preloadassetdb.txt') {
        const source = utf8.decode(bytes)
        ;(data as SC2MapDocumentData).preloadAssetDb = rememberText(
          readPreloadAssetDb(source), source, writePreloadAssetDb,
        )
      } else if (name.startsWith('cellattribute_')) {
        const suffix = path.replaceAll('\\', '/').split('/').at(-1)!.slice('CellAttribute_'.length)
        const dimensions = data.info === undefined
          ? undefined
          : { sizeX: data.info.width, sizeY: data.info.height }
        cellAttributes[suffix.toLowerCase()] = dimensions === undefined
          ? { path, suffix, byteLength: bytes.byteLength, missingContext: 'map-dimensions' }
          : { path, suffix, byteLength: bytes.byteLength, value: readCellAttribute(bytes, dimensions) }
      }
    } catch (error) {
      options.onError?.(path, error)
    }
  }

  if (Object.keys(cellAttributes).length > 0) {
    ;(data as SC2MapDocumentData).cellAttributes = Object.freeze(cellAttributes)
  }
  legacyBaseline.set(data, serializeMapEntries(data))
  return data as SC2MapDocumentData
}

function replaceOrAdd(
  out: Map<string, Uint8Array>,
  source: ReadonlyMap<string, Uint8Array>,
  names: readonly string[],
  canonical: string,
  bytes: Uint8Array,
): void {
  const path = originalPath(source, new Set(names))
  out.set(path ?? canonical, bytes)
  if (path !== undefined && path !== canonical) out.delete(canonical)
}

/** Serialize MK3-owned documents back to their original namespace paths. */
export function serializeSc2MapDocuments(data: SC2MapDocumentData): Map<string, Uint8Array> {
  const out = serializeMapEntries(data)
  const source = data.rawFiles
  const baseline = legacyBaseline.get(data)

  // The frozen aggregate eagerly writes every modeled field. Restore authored bytes when its
  // normalized representation is unchanged; a semantic mutation changes the normalized bytes
  // and therefore continues through the native writer.
  if (baseline !== undefined) {
    for (const [path, raw] of source) {
      if (equalBytes(out.get(path), baseline.get(path))) out.set(path, raw)
    }
  }

  if (data.editorCategories !== undefined && originalPath(source, new Set(['editorcategories.xml'])) !== undefined) {
    replaceOrAdd(out, source, ['editorcategories.xml'], 'EditorCategoryData', writeTextPreserving(data.editorCategories, writeEditorCategories))
  }
  if (data.preload !== undefined && originalPath(source, new Set(['preload.xml'])) !== undefined) {
    replaceOrAdd(out, source, ['preload.xml'], 'Preload', writeTextPreserving(data.preload, writePreload))
  }
  if (data.customAi !== undefined) {
    replaceOrAdd(out, source, ['customai'], 'CustomAI', utf8Encoder.encode(writeAIData(data.customAi)))
  }
  if (data.attributes !== undefined) {
    replaceOrAdd(out, source, ['attributes'], 'Attributes', utf8Encoder.encode(writeAttributes(data.attributes)))
  }
  if (data.paintedCreep !== undefined) {
    replaceOrAdd(out, source, ['paintedcreeplayer'], 'PaintedCreepLayer', writePaintedPathing(data.paintedCreep))
  }
  if (data.preloadAssetDb !== undefined) {
    replaceOrAdd(out, source, ['preloadassetdb.txt'], 'PreloadAssetDB.txt', writeTextPreserving(data.preloadAssetDb, writePreloadAssetDb))
  }
  for (const document of Object.values(data.cellAttributes ?? {})) {
    if (document.value !== undefined) out.set(document.path, writeCellAttribute(document.value))
  }
  return out
}
