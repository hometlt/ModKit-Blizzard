/**
 * The strings vocabulary, derived from the documents the host put in the workspace snapshot.
 *
 * Completion in a localization file is almost entirely about *other* files. `Unit/Name/Marine` names
 * an entity in a GameData catalog; `<c val="ColorAttackInfo">` and `<s val="StandardTooltip">` name
 * constants declared in `FontStyles.SC2Style`. MK2 answered all three from a loaded mod. MK3 has no
 * mod object at this layer and does not need one: `common.language/document-analysis@1` already
 * carries a bounded workspace snapshot with every request, so the neighbours are right there.
 *
 * What this deliberately does not do is fetch. A snapshot is what the host chose to include, and a
 * vocabulary built from it is honest about its limits — an empty style list means "no style sheet is
 * in this snapshot", and the completion engine offers nothing rather than something invented.
 */
import { createReferenceIndex, scanXml } from '@modkit/codec-kit'
import { starcraft2NamespaceForType } from '@modkit/blizzard-starcraft2/schema'
import { createResolvedStyleSnapshot } from '../../modules/style/shared/font-styles.js'
import { catalogEntities } from '../../modules/data/shared/format/language/entity.js'
import { getAttr } from '@modkit/codec-kit'
import type { StringCatalog } from '../../modules/strings/shared/core/complete.js'
import { parseSc2Strings } from '../../modules/strings/shared/core/text-file.js'
import type { CatalogResolver } from '../../modules/strings/shared/core/resolve.js'
import {
  catalogResolverFromSnapshot,
  stringCatalogFromSources,
  type CatalogSnapshotLike,
  type CatalogTextStyles,
} from './catalog-resolver.js'

/** The shape a `LanguageDocument` presents; declared locally so this module stays SDK-free. */
export interface WorkspaceDocumentLike {
  readonly uri: string
  readonly languageId: string
  readonly text: string
  readonly version?: number
}

const STYLE_SHEET = /\.SC2Style$|FontStyles/iu
const CATALOG_FILE = /\.xml$/iu
const STRINGS_FILE = /\.txt$/iu
/** `Assets.txt` and `AssetsProduct.txt`: aliases `<img path="@@Alias">` names, not string keys (parity plan 4.7). */
const ASSETS_FILE = /(?:^|[\\/])Assets(?:Product)?\.txt$/iu

interface WorkspaceSources {
  readonly snapshot: CatalogSnapshotLike
  readonly styles: CatalogTextStyles
  readonly keys: readonly string[]
  readonly assets: ReadonlyMap<string, string>
}

/**
 * Read one workspace snapshot into the vocabulary the completion engine consumes.
 *
 * Routing is by what a document says it is, then by its name — the host labels a GameData buffer
 * `sc2-data` when it knows, and a snapshot assembled from a file listing may carry only paths.
 */
function sourcesFromWorkspace(
  documents: readonly WorkspaceDocumentLike[],
  primaryKeys: readonly string[] = [],
): WorkspaceSources {
  const entities: {
    namespace: string
    entityId: string
    fields: Record<string, unknown>
  }[] = []
  const styleSources: Array<{ uri: string; version?: number; text: string }> = []
  const keys = [...primaryKeys]
  const localizedStrings: NonNullable<CatalogSnapshotLike['localizedStrings']>[number][] = []
  const assets = new Map<string, string>()

  for (const document of documents) {
    const isStyle =
      document.languageId === 'sc2-style' || STYLE_SHEET.test(document.uri)
    if (isStyle) {
      styleSources.push({ uri: document.uri, version: document.version, text: document.text })
      continue
    }
    if (document.languageId === 'sc2-data' || CATALOG_FILE.test(document.uri)) {
      for (const element of catalogEntities(scanXml(document.text))) {
        const id = getAttr(element, 'id')?.value
        const namespace = starcraft2NamespaceForType(element.tag)
        if (id === undefined || id === '' || namespace === undefined) continue
        entities.push({
          namespace,
          entityId: id,
          fields: Object.fromEntries(
            element.children.map(child => [child.tag, getAttr(child, 'value')?.value ?? '']),
          ),
        })
      }
      continue
    }
    // The strings owner's reader: `//` comment lines are neither aliases nor keys.
    if (ASSETS_FILE.test(decodeURIComponent(document.uri))) {
      for (const [alias, path] of parseSc2Strings(document.text)) if (alias !== '') assets.set(alias, path.trim())
      continue
    }
    if (document.languageId === 'sc2-strings' || STRINGS_FILE.test(document.uri)) {
      for (const [key, value] of parseSc2Strings(document.text)) {
        if (key === '') continue
        keys.push(key)
        localizedStrings.push({ key, value, resolvedLocale: 'workspace' })
      }
    }
  }

  const resolvedStyles = createResolvedStyleSnapshot(styleSources, {
    complete: false,
    authoritativeOrder: false,
  })
  const styles: CatalogTextStyles = {
    constants: Object.fromEntries(
      [...resolvedStyles.sheet.constants.keys()].map(name => [
        name,
        resolvedStyles.resolveConstant(name) ?? resolvedStyles.sheet.constants.get(name)!,
      ]),
    ),
    styles: Object.fromEntries(
      [...resolvedStyles.sheet.styles.keys()].flatMap(name => {
        const style = resolvedStyles.resolveStyle(name)
        return style === undefined ? [] : [[name, style]]
      }),
    ),
    complete: resolvedStyles.complete,
    contextRevision: resolvedStyles.contextRevision,
  }
  return { snapshot: { entities, localizedStrings }, styles, keys, assets }
}

export function stringCatalogFromWorkspace(
  documents: readonly WorkspaceDocumentLike[],
  primaryKeys: readonly string[] = [],
): StringCatalog {
  return stringCatalogFromSources(sourcesFromWorkspace(documents, primaryKeys))
}

/** Resolve markup against exactly the documents supplied by the host. */
export function stringResolverFromWorkspace(
  documents: readonly WorkspaceDocumentLike[],
): CatalogResolver {
  const sources = sourcesFromWorkspace(documents)
  return catalogResolverFromSnapshot(sources.snapshot, sources.styles).resolver
}

/**
 * Which documents in a workspace reference which styles and constants.
 *
 * The question a modder asks before deleting a style is "who uses this", and it is asked across
 * files: a style sheet does not know its own users. The two-way bookkeeping is the shared
 * `createReferenceIndex` — the algorithm MK2 wrote as `project-index` and proved there — so the only
 * thing decided here is what counts as a reference, which is the format's business.
 *
 * It answers about the snapshot it was given, and says how much that was. A caller that needs the
 * whole mod asks the host for more documents rather than assuming this index is the world.
 */
export function styleUsageIndex(
  documents: readonly WorkspaceDocumentLike[],
  referencesOf: (text: string) => Iterable<string>,
) {
  const index = createReferenceIndex({
    // Two spellings of one path are one document; a host that means them apart keeps them apart.
    normalizeDocumentId: id => id.replaceAll(String.fromCharCode(92), '/').toLowerCase(),
  })
  for (const document of documents) {
    if (document.languageId !== 'sc2-strings' && !STRINGS_FILE.test(document.uri)) continue
    index.set(document.uri, referencesOf(document.text))
  }
  return index
}
