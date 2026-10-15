/**
 * The GameStrings diagnostics and value-markup hover a loaded mod's server gives (owner: [SC2] Mod & Data, Strings
 * language; served by the SC2 mod server, `modules/mod/shared/workspace/mod-contexts.ts`).
 *
 * A catalog's markup (`<d ref>`, `<d stringref>`, styles and colours) is checked against a resolver
 * over the chain's Data catalogs, style sheets and string catalogs — the same
 * `stringResolverFromWorkspace` and `sc2StringsDiagnosticsWith` the language provider runs over a
 * workspace snapshot, with the asked catalog first as the snapshot puts the request's document
 * first. The set is replaced per server revision (classified by the host's language routes); a
 * resolver is kept for the last few asked catalogs of that revision, since building one reads every
 * Data catalog of the chain.
 */
import type { LanguageDiagnosticList, LanguageHover, LanguagePosition } from '@modkit/sdk'
import { stringResolverFromWorkspace } from '../../../../../shared/language/string-workspace.js'
import type { CatalogResolver } from '../../../shared/core/index.js'
import { sc2StringsDiagnosticsWith, sc2StringsValueHoverWith } from './language.js'

/** A catalog, style sheet or Data catalog of the chain, with the language the host gives it. */
export interface StringsServedDiagnosticDocument {
  readonly layerId: string
  readonly path: string
  readonly languageId: string
  readonly text: string
}

export interface StringsServedDiagnostics {
  /** Markup hover using the same retained resolver as diagnostics. */
  hover(layerId: string, path: string, uri: string, position: LanguagePosition): LanguageHover | undefined
  /** Replace the set with these documents, in chain order. */
  update(documents: Iterable<StringsServedDiagnosticDocument>): void
  /**
   * The diagnostics of a held catalog under the editor's `uri`, within `maxResults`;
   * `incomplete` says whether the asking workspace is. Undefined when the catalog is not held.
   */
  diagnostics(
    layerId: string,
    path: string,
    uri: string,
    options: { readonly maxResults: number; readonly incomplete: boolean },
  ): LanguageDiagnosticList | undefined
}

/** Resolvers kept per revision: one per asked catalog, the oldest dropped first. */
const MAX_RESOLVERS = 4
const keyOf = (layerId: string, path: string): string => JSON.stringify([layerId, path])

export function createStringsServedDiagnostics(): StringsServedDiagnostics {
  let documents: (StringsServedDiagnosticDocument & { readonly key: string; readonly uri: string })[] = []
  const resolvers = new Map<string, CatalogResolver | undefined>()
  /** Select a catalog and reuse its resolver until this set's revision changes. */
  const contextAt = (layerId: string, path: string) => {
    const key = keyOf(layerId, path)
    const primary = documents.find(document => document.key === key && document.languageId === 'sc2-strings')
    if (primary === undefined) return undefined
    let resolver = resolvers.get(key)
    if (!resolvers.has(key) && documents.some(document => document.languageId === 'sc2-data')) {
      resolver = stringResolverFromWorkspace([primary, ...documents.filter(document => document !== primary)])
    }
    resolvers.delete(key)
    resolvers.set(key, resolver)
    while (resolvers.size > MAX_RESOLVERS) resolvers.delete(resolvers.keys().next().value as string)
    return { primary, resolver }
  }
  return {
    update(next) {
      documents = [...next].map(document => ({
        ...document,
        key: keyOf(document.layerId, document.path),
        uri: `modkit-served-strings://${encodeURIComponent(document.layerId)}/${document.path}`,
      }))
      resolvers.clear()
    },
    diagnostics(layerId, path, uri, options) {
      const context = contextAt(layerId, path)
      return context === undefined ? undefined : sc2StringsDiagnosticsWith(
        { uri, text: context.primary.text }, context.resolver, options.maxResults, options.incomplete)
    },
    hover(layerId, path, uri, position) {
      const context = contextAt(layerId, path)
      return context === undefined ? undefined : sc2StringsValueHoverWith(
        { document: { uri, languageId: 'sc2-strings', version: 0, text: context.primary.text }, position },
        context.resolver ?? stringResolverFromWorkspace([context.primary, ...documents.filter(document => document !== context.primary)]))
    },
  }
}
