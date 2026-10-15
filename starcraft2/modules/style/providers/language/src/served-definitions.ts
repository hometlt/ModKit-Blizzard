/**
 * Style, Constant and FontGroup declarations and users a loaded mod's server answers (owner: the SC2 Style
 * language model in `style-names.ts`; served by `modules/mod/shared/workspace/mod-contexts.ts`).
 *
 * One retained set of a chain's style sheets, read with the same `inheritedNames` and
 * `styleOccurrences` the snapshot path runs, so a definition request from a catalog carries only its
 * live document instead of every sheet and catalog of the chain. Sheets are keyed by the server's
 * `layerId` and path; an update re-reads occurrences only when some sheet's text changed (a sheet's
 * declarations depend on the names every sheet declares). Answers name sheets by layer and path
 * with ranges; the caller maps them to its URIs and orders and bounds them as the snapshot path does.
 * References reuse `styleNameReferences` over retained sheets/catalogs/layouts, bounded by documents
 * and text size; omitted inputs leave the answer incomplete.
 */
import { inheritedNames, Positions, sameName, styleOccurrences, styleNameReferences, type StyleNameKind, type StyleNameOccurrence } from './style-names.js'
import type { LanguageDocument, LanguagePosition, LanguageReferencesRequest } from '@modkit/sdk'

export interface StyleServedSheet {
  readonly layerId: string
  readonly path: string
  readonly text: string
}

export interface StyleServedDefinitions {
  readonly documents: readonly { readonly layerId: string; readonly path: string }[]
  readonly definitions: readonly {
    readonly document: number
    readonly range: ReturnType<Positions['range']>
  }[]
}

/** A retained set of a chain's style sheets with their occurrences. */
export function createStyleServedDefinitions() {
  let sheets: readonly (StyleServedSheet & { readonly occurrences: readonly StyleNameOccurrence[] })[] = []
  let userSource: readonly (StyleServedSheet & { readonly languageId: string })[] | undefined
  let users: readonly LanguageDocument[] = []
  let usersIncomplete = false
  let places = new Map<string, { readonly layerId: string; readonly path: string }>()
  return {
    /** Hold the chain's users by revision; text stays owned by the mod server. */
    updateUsers(next: readonly (StyleServedSheet & { readonly languageId: string })[]): void {
      if (next === userSource) return
      userSource = next
      places = new Map()
      let chars = 0
      usersIncomplete = false
      const kept: LanguageDocument[] = []
      for (const document of next) {
        if (!['sc2-style', 'sc2-strings', 'sc2-layout'].includes(document.languageId)) continue
        if (kept.length >= 4096 || document.text.length > 64 * 1024 * 1024 || chars + document.text.length > 128 * 1024 * 1024) {
          usersIncomplete = true
          continue
        }
        chars += document.text.length
        const uri = `modkit-served-style://${encodeURIComponent(document.layerId)}/${document.path}`
        places.set(uri, { layerId: document.layerId, path: document.path })
        kept.push(Object.freeze({ uri, languageId: document.languageId, version: 0, text: document.text }))
      }
      users = kept
    },
    /** References through the canonical Style owner, named by layer/path for the Host. */
    references(layerId: string, path: string, position: LanguagePosition,
      options: { readonly includeDeclaration: boolean; readonly maxResults: number; readonly incomplete: boolean }) {
      const uri = `modkit-served-style://${encodeURIComponent(layerId)}/${path}`
      const document = users.find(item => item.uri === uri)
      if (document === undefined) return { documents: [], references: [], isIncomplete: true }
      const answer = styleNameReferences({ document, workspaceDocuments: users, position, maxDocuments: 4096,
        maxResults: options.maxResults, includeDeclaration: options.includeDeclaration,
        workspaceIncomplete: options.incomplete || usersIncomplete } as LanguageReferencesRequest)
      const documents: { readonly layerId: string; readonly path: string }[] = []
      const slots = new Map<string, number>()
      const references = answer.locations.map(location => {
        let slot = slots.get(location.uri)
        if (slot === undefined) {
          const place = places.get(location.uri)
          if (place === undefined) throw new TypeError('style.references named a document outside its chain')
          slot = documents.push(place) - 1
          slots.set(location.uri, slot)
        }
        return { document: slot, range: location.range }
      })
      return { documents, references, isIncomplete: answer.isIncomplete }
    },
    /** Bring the set to these sheets, in chain order; unchanged texts keep their occurrences. */
    update(next: readonly StyleServedSheet[]): void {
      if (next.length === sheets.length && next.every((sheet, index) => {
        const held = sheets[index]!
        return held.layerId === sheet.layerId && held.path === sheet.path && held.text === sheet.text
      })) return
      const declared = inheritedNames(next)
      sheets = next.map(sheet => ({ ...sheet, occurrences: styleOccurrences(sheet.text, declared) }))
    },
    /** Every declaration of a name of a kind, sheet by sheet in document order. */
    definitions(kind: StyleNameKind, name: string): StyleServedDefinitions {
      const target = { kind, name, start: 0, end: 0, declaration: true }
      const documents: { layerId: string; path: string }[] = []
      const definitions: { document: number; range: ReturnType<Positions['range']> }[] = []
      for (const sheet of sheets) {
        const found = sheet.occurrences.filter(item => item.declaration && sameName(item, target))
        if (found.length === 0) continue
        const index = new Positions(sheet.text)
        const document = documents.length
        documents.push({ layerId: sheet.layerId, path: sheet.path })
        for (const item of found) definitions.push({ document, range: index.range(item.start, item.end) })
      }
      return { documents, definitions }
    },
  }
}

export type StyleServedDefinitionSet = ReturnType<typeof createStyleServedDefinitions>
