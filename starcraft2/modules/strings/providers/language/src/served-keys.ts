/**
 * The GameStrings key answers a loaded mod's server gives (owner: [SC2] Mod & Data, Strings
 * language; served by the SC2 mod server, `modules/mod/shared/workspace/mod-contexts.ts`).
 *
 * One retained set of the chain's string catalogs (`.txt`), layouts (`.SC2Layout`) and Galaxy
 * scripts (`.galaxy`, whose `StringExternal("Key")` names a key), with the
 * session's unsaved text, searched by the same `stringKeyLocations` and `stringKeyDefinedIn` the
 * language provider runs over a workspace snapshot: a key's definitions and uses, and how many
 * other catalogs define it. A request then carries only its live document instead of every catalog
 * of every locale. Files are named by the server's own `layerId` and path; the asked catalog comes
 * first, as the snapshot puts the request's document first. Data entities a value names are
 * answered by the provider from the snapshot.
 */
import type { LanguageRange } from '@modkit/sdk'
import { stringKeyDefinedIn, stringKeyLocations, type StringKeyDocument } from './workspace.js'

/** A catalog, layout or Galaxy script of the chain. */
export interface StringsServedDocument {
  readonly layerId: string
  readonly path: string
  readonly text: string
}

/** A place in the chain: a document by layer and path. */
export interface StringsServedPlace {
  readonly layerId: string
  readonly path: string
}

export interface StringsServedLocations {
  readonly capped: boolean
  readonly documents: readonly StringsServedPlace[]
  readonly locations: readonly { readonly document: number; readonly range: LanguageRange }[]
}

export interface StringsServedKeys {
  /** Bring the set to these files, in chain order; other files are ignored. */
  update(documents: Iterable<StringsServedDocument>): void
  /** A key's definitions and uses, the `primary` catalog first. */
  locations(
    key: string,
    primary: StringsServedPlace,
    mode: { readonly definitions: boolean; readonly uses: boolean },
    maxResults: number,
  ): StringsServedLocations
  /** How many catalogs other than `primary` define the key on a line of their own. */
  otherCatalogs(key: string, primary: StringsServedPlace): number
}

const CATALOG = /\.txt$/iu
const LAYOUT = /\.sc2layout$/iu
const SCRIPT = /\.galaxy$/iu
const keyOf = (place: StringsServedPlace): string => JSON.stringify([place.layerId, place.path])

/** A retained set of one chain's catalogs, layouts and scripts, replaced per server revision. */
export function createStringsServedKeys(): StringsServedKeys {
  let catalogs: (StringKeyDocument & StringsServedPlace)[] = []
  let layouts: (StringKeyDocument & StringsServedPlace)[] = []
  let scripts: (StringKeyDocument & StringsServedPlace)[] = []
  return {
    update(documents) {
      const nextCatalogs: typeof catalogs = []
      const nextLayouts: typeof layouts = []
      const nextScripts: typeof scripts = []
      for (const document of documents) {
        const held = { layerId: document.layerId, path: document.path, uri: keyOf(document), text: document.text }
        if (CATALOG.test(document.path)) nextCatalogs.push(held)
        else if (LAYOUT.test(document.path)) nextLayouts.push(held)
        else if (SCRIPT.test(document.path)) nextScripts.push(held)
      }
      catalogs = nextCatalogs
      layouts = nextLayouts
      scripts = nextScripts
    },
    locations(key, primary, mode, maxResults) {
      const asked = keyOf(primary)
      const ordered = [...catalogs.filter(item => item.uri === asked), ...catalogs.filter(item => item.uri !== asked)]
      const found = stringKeyLocations(key, ordered, layouts, mode, maxResults, scripts)
      const places = new Map([...catalogs, ...layouts, ...scripts].map(item => [item.uri, item]))
      const documents: StringsServedPlace[] = []
      const slots = new Map<string, number>()
      const locations = found.locations.map(location => {
        let slot = slots.get(location.uri)
        if (slot === undefined) {
          const place = places.get(location.uri)!
          slot = documents.length
          slots.set(location.uri, slot)
          documents.push(Object.freeze({ layerId: place.layerId, path: place.path }))
        }
        return Object.freeze({ document: slot, range: location.range })
      })
      return Object.freeze({ capped: found.capped, documents: Object.freeze(documents), locations: Object.freeze(locations) })
    },
    otherCatalogs(key, primary) {
      const asked = keyOf(primary)
      return catalogs.filter(item => item.uri !== asked && stringKeyDefinedIn(item.text, key)).length
    },
  }
}
