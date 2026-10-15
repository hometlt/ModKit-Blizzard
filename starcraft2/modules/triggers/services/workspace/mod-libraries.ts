/**
 * The dependency TriggerData and Galaxy declarations of one mod, read through the one mod loader.
 *
 * A layer's `LibraryList.xml` names the libraries the editor loads with it, so the list is read
 * from every layer rather than through the context's last-layer-wins `locate`: Liberty's list
 * replaces Core's when a single path is resolved, but the editor loads NativeLib *and* LibertyLib.
 * A Galaxy `include`, in contrast, names one file, and there the last layer rightly wins.
 */
import { parseGalaxySource } from '../../../galaxy/services/analysis/source.js'
import { SyntaxKind, type IncludeStatement } from '../../../galaxy/language-core/types.js'

/** The part of `ModContext` this needs: the load order, and a read confined to a layer's files. */
export interface ModContextReader {
  readonly layers: readonly { readonly id: string; readonly role: 'dependency' | 'base' | 'primary' }[]
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
}

/** Declarations also need to list a layer and to resolve one path across the whole chain. */
export interface ModContextIndex extends ModContextReader {
  files(
    layerId: string,
    page: { readonly cursor?: string; readonly limit: number; readonly prefix?: string },
  ): Promise<{ readonly items: readonly string[]; readonly nextCursor?: string }>
  locate(path: string): Promise<{ readonly layerId: string; readonly path: string } | undefined>
}

/** One dependency as the TriggerData codec takes it. */
export interface TriggerDependencyLibrary {
  readonly triggerData: string
  readonly triggerStrings?: string
  readonly sourcePath: string
  /** The opened package's own Triggers: the other libraries of the document being converted. */
  readonly sameDocument?: boolean
}

export interface TriggerDependencyOptions {
  /** Locale folders to look for `TriggerStrings.txt` in, most wanted first. */
  readonly locales?: readonly string[]
  readonly maxBytes?: number
  /** The opened package is a mod whose one library is being converted: its own Triggers holds the
   *  other libraries of that document (EditorTest's CAI2 uses CCUI and TIBW) and is returned marked
   *  `sameDocument`; the conversion leaves out the library it reconstructs. */
  readonly ownLibraries?: boolean
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const LIBRARY_LIST = 'Base.SC2Data/TriggerLibs/LibraryList.xml'
/** A library keeps its own extension: `NativeLib.TriggerLib`, but `LibertyLib.SC2Lib`. */
const LIBRARY_EXTENSIONS = ['.SC2Lib', '.TriggerLib'] as const
const EXTERNAL = /<library\b[^>]*\bexternal="([^"]+)"/giu

const decoder = new TextDecoder()

export async function readTriggerDependencies(
  context: ModContextReader,
  options: TriggerDependencyOptions = {},
): Promise<TriggerDependencyLibrary[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const locales = options.locales ?? ['enUS']

  /** A file a layer does not list is not an error here: most layers carry no triggers at all. */
  const text = async (layerId: string, path: string): Promise<string | undefined> => {
    try {
      return decoder.decode(await context.read(layerId, path, maxBytes))
    } catch {
      return undefined
    }
  }
  const first = async (layerId: string, paths: readonly string[]): Promise<[string, string] | undefined> => {
    for (const path of paths) {
      const found = await text(layerId, path)
      if (found !== undefined) return [path, found]
    }
    return undefined
  }
  const stringsOf = async (layerId: string): Promise<string | undefined> =>
    (await first(layerId, locales.map(locale => `${locale}.SC2Data/LocalizedData/TriggerStrings.txt`)))?.[1]

  const libraries: TriggerDependencyLibrary[] = []
  for (const layer of context.layers) {
    const strings = await stringsOf(layer.id)
    const add = (sourcePath: string, triggerData: string): void => {
      libraries.push({ triggerData, sourcePath, ...(strings === undefined ? {} : { triggerStrings: strings }) })
    }
    // A mod authored in the editor keeps its triggers in the package root, next to its components.
    // The opened package's own Triggers is the subject, not a dependency of itself: handing it back
    // as one would let a conversion resolve references against the very document it has to
    // reconstruct. A mod's other libraries in it are asked for separately (ownLibraries).
    if (layer.role !== 'primary') {
      const own = await text(layer.id, 'Triggers')
      if (own !== undefined) add('Triggers', own)
    } else if (options.ownLibraries) {
      const own = await text(layer.id, 'Triggers')
      if (own !== undefined) {
        libraries.push({ triggerData: own, sourcePath: 'Triggers', sameDocument: true, ...(strings === undefined ? {} : { triggerStrings: strings }) })
      }
    }

    const list = await text(layer.id, LIBRARY_LIST)
    if (list === undefined) continue
    for (const [, external] of list.matchAll(EXTERNAL)) {
      const base = `Base.SC2Data/${external!.replaceAll('\\', '/')}`
      const found = await first(layer.id, LIBRARY_EXTENSIONS.map(extension => `${base}${extension}`))
      if (found !== undefined) add(found[0], found[1])
    }
  }
  return libraries
}

/** One Galaxy declaration file as the conversion takes it. */
export interface TriggerGalaxyDeclaration {
  readonly fileName: string
  readonly text: string
}

export interface TriggerDeclarationOptions {
  /** Galaxy sources whose `include` lines start the walk — the map's own script, usually. */
  readonly sources?: readonly string[]
  readonly maxBytes?: number
  /** Runtime needs exactly the include closure, not editor-wide headers/natives/GameData. */
  readonly scope?: 'editor-declarations' | 'include-closure'
}

const DATA_ROOT = 'Base.SC2Data/'
const NATIVE_DECLARATIONS = ['natives.galaxy', 'natives_missing.galaxy', 'NativeLib_h.galaxy'] as const
const GAME_DATA = 'Base.SC2Data/TriggerLibs/GameData/'
const INCLUDE = /\binclude\s+"([^"]+)"/gu
const includes = (text: string, strict: boolean): string[] => {
  if (!strict) return [...text.matchAll(INCLUDE)].map(match => match[1]!)
  const parsed = parseGalaxySource(text, { preserveSourceText: false })
  if (parsed.parseDiagnostics.length > 0)
    throw new TypeError(`Galaxy include source has ${parsed.parseDiagnostics.length} syntax error(s)`)
  return parsed.statements
    .filter((statement): statement is IncludeStatement => statement.kind === SyntaxKind.IncludeStatement)
    .map(statement => {
      const path = statement.path.text
      if (!path) throw new TypeError('Galaxy include has no path')
      return path.replaceAll('"', '')
    })
}
/** A library header sits in the data root of the mod that owns it: `LibLbty_h.galaxy`. */
const LIBRARY_HEADER = /^Base\.SC2Data\/Lib[A-Za-z0-9_]+_h\.galaxy$/iu

/**
 * The Galaxy declarations a conversion needs: library headers, the natives of the chain, and
 * everything the sources include, followed transitively.
 */
export async function readTriggerDeclarations(
  context: ModContextIndex,
  options: TriggerDeclarationOptions = {},
): Promise<TriggerGalaxyDeclaration[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const declarations: TriggerGalaxyDeclaration[] = []
  const seen = new Set<string>()

  /** A path the chain does not hold is not an error: most of these files are optional. */
  const add = async (path: string): Promise<string | undefined> => {
    const key = path.toLowerCase()
    if (seen.has(key)) return undefined
    const found = await context.locate(path)
    if (found === undefined) return undefined
    seen.add(key)
    const text = decoder.decode(await context.read(found.layerId, found.path, maxBytes))
    declarations.push({ fileName: found.path, text })
    return text
  }
  const listed = async (layerId: string, prefix: string): Promise<string[]> => {
    const items: string[] = []
    let cursor: string | undefined
    do {
      const page = await context.files(layerId, { limit: 10_000, prefix, ...(cursor === undefined ? {} : { cursor }) })
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return items
  }

  if (options.scope !== 'include-closure') {
    for (const layer of context.layers) {
      for (const file of await listed(layer.id, DATA_ROOT)) {
        if (LIBRARY_HEADER.test(file)) await add(file)
      }
    }
  }

  const strict = options.scope === 'include-closure'
  const pending = (options.sources ?? []).flatMap(source => includes(source, strict))
  while (pending.length > 0) {
    const include = pending.shift()!.replaceAll('\\', '/').replace(/\.galaxy$/iu, '')
    let resolved = false
    for (const candidate of [`${DATA_ROOT}${include}_h.galaxy`, `${DATA_ROOT}${include}.galaxy`]) {
      if (seen.has(candidate.toLowerCase())) { resolved = true; continue }
      const text = await add(candidate)
      if (text !== undefined) {
        resolved = true
        pending.push(...includes(text, strict))
      }
    }
    if (strict && !resolved) throw new Error(`Galaxy include not found: ${include}`)
  }

  if (options.scope === 'include-closure') return declarations
  for (const name of NATIVE_DECLARATIONS) await add(`${DATA_ROOT}TriggerLibs/${name}`)

  // The generated GameData declarations are one logical unit, and the converter takes whole files.
  const parts: string[] = []
  for (const layer of context.layers) {
    for (const file of (await listed(layer.id, GAME_DATA)).sort()) {
      if (!file.toLowerCase().endsWith('.galaxy')) continue
      parts.push(decoder.decode(await context.read(layer.id, file, maxBytes)))
    }
  }
  if (parts.length > 0) declarations.push({ fileName: `${GAME_DATA}*.galaxy`, text: parts.join('\n') })
  return declarations
}
