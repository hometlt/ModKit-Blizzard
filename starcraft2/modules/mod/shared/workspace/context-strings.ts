/**
 * The localized strings of a mod context, handed out a few keys at a time (`data.strings`).
 *
 * A card drawn from the context's catalog names units, buttons and hotkeys by these keys
 * (`Unit/Name/Marine`, `Button/Tooltip/Stimpack`, `Button/Hotkey/Stimpack`); without them it can
 * only print ids. Each locale's `GameStrings.txt` and `GameHotkeys.txt` of every layer is read once,
 * in load order, so the last layer that defines a key wins as it does in the game; the text is
 * parsed by the strings owner.
 *
 * A key is answered in the first locale of the chain that has it — the locales asked for, then
 * enUS, then any other locale the layers carry — and says when that is not the first (`fallback`),
 * as the host's resolved data does. An installation holds the text of the locales it downloaded
 * only: the others are listed by CASC but cannot be read, so a locale's file that cannot be read is
 * skipped and the chain moves on, and the next locale is read only while keys are still missing.
 * Overlay invalidation discards only affected locale tables and rediscoverable locale names;
 * unrelated edits retain translations and their source provenance.
 * Localized input paths are indexed once per source revision, shared across locale tables: looking
 * for another fallback locale never enumerates a huge CASC layer again. Empty questions do no I/O.
 * Reads within one locale overlap in batches of four; merging remains in layer/file order and
 * only one batch of raw document bytes is retained. Other locales remain lazy.
 */
import type { DataLocalizedString } from '@modkit/sdk/data'
import { parseSc2Strings } from '../../../strings/shared/core/text-file.js'

export interface StringsLayer {
  readonly id: string
  readonly sourcePath: string
  /** The layer's address, which a string's source names it by. */
  readonly rootId: string
}

interface Entry {
  readonly value: string
  readonly rootId: string
  readonly path: string
  readonly documentIndex: number
}

type LocaleStrings = ReadonlyMap<string, Entry>

/** Only localized data inputs are retained; unrelated asset names stay with the loader. */
interface StringInputs {
  readonly locales: readonly string[]
  readonly files: ReadonlyMap<string, readonly { readonly layer: StringsLayer; readonly file: string }[]>
}

export interface ContextStrings {
  /** Canonical relative paths changed by this view; only their localized inputs are discarded. */
  invalidate(paths: readonly string[]): void
  answer(request: unknown, contextLocales: readonly string[], signal?: AbortSignal): Promise<readonly DataLocalizedString[]>
}

const STRING_FILES = new Set(['gamestrings.txt', 'gamehotkeys.txt'])
const LOCALIZED_DATA = /^([a-z]{2})([a-z]{2})\.sc2data\/localizeddata\//iu
const MAXIMUM_DOCUMENT_BYTES = 64 * 1024 * 1024
const READ_CONCURRENCY = 4
export const MAXIMUM_STRING_KEYS = 10_000
const MAXIMUM_LOCALES = 8
const LOCALE = /^[a-z]{2}[A-Z]{2}$/u
const decoder = new TextDecoder()

/** The keys and the locales asked for in a `data.strings` question, or a refusal. */
function stringsRequest(request: unknown): { readonly keys: readonly string[]; readonly locales?: readonly string[] } {
  const value = request as { readonly keys?: unknown; readonly locales?: unknown } | null
  const keys = value?.keys
  if (
    !Array.isArray(keys) ||
    keys.length > MAXIMUM_STRING_KEYS ||
    !keys.every(key => typeof key === 'string' && key !== '')
  ) {
    throw new Error(`data.strings needs up to ${MAXIMUM_STRING_KEYS} non-empty keys`)
  }
  const locales = value?.locales
  if (locales === undefined) return { keys }
  if (
    !Array.isArray(locales) ||
    locales.length === 0 ||
    locales.length > MAXIMUM_LOCALES ||
    !locales.every(locale => typeof locale === 'string' && LOCALE.test(locale))
  ) {
    throw new Error(`data.strings locales are 1 to ${MAXIMUM_LOCALES} names like enUS`)
  }
  return { keys, locales }
}

/** The strings of one resolved chain; every context over it shares them. */
export function contextStrings(options: {
  readonly layers: readonly StringsLayer[]
  files(layerId: string): Promise<readonly string[]>
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
}): ContextStrings {
  const byLocale = new Map<string, Promise<LocaleStrings>>()
  let inputs: Promise<StringInputs> | undefined

  /** Discover locale names and their exact input spellings once, preserving layer and file order. */
  const stringInputs = (): Promise<StringInputs> => {
    if (inputs !== undefined) return inputs
    const pending = (async () => {
      const found = new Set<string>()
      const files = new Map<string, { readonly layer: StringsLayer; readonly file: string }[]>()
      for (const layer of options.layers) {
        for (const file of await options.files(layer.id)) {
          const match = LOCALIZED_DATA.exec(file)
          if (match === null) continue
          const locale = `${match[1]!.toLowerCase()}${match[2]!.toUpperCase()}`
          found.add(locale)
          if (!STRING_FILES.has(file.slice(match[0].length).toLowerCase())) continue
          const key = locale.toLowerCase()
          let rows = files.get(key)
          if (rows === undefined) { rows = []; files.set(key, rows) }
          rows.push({ layer, file })
        }
      }
      return { locales: [...found].sort(), files }
    })()
    inputs = pending
    void pending.catch(() => { if (inputs === pending) inputs = undefined })
    return pending
  }

  const localeStrings = (locale: string): Promise<LocaleStrings> => {
    let built = byLocale.get(locale)
    if (built === undefined) {
      built = (async () => {
        const strings = new Map<string, Entry>()
        let documentIndex = 0
        const rows = (await stringInputs()).files.get(locale.toLowerCase()) ?? []
        for (let start = 0; start < rows.length; start += READ_CONCURRENCY) {
          const batch = rows.slice(start, start + READ_CONCURRENCY)
          const contents = await Promise.all(batch.map(async ({ layer, file }) => {
            try { return await options.read(layer.id, file, MAXIMUM_DOCUMENT_BYTES) }
            catch { return undefined } // Listed locales need not be downloaded.
          }))
          for (const [index, { layer, file }] of batch.entries()) {
            const bytes = contents[index]
            if (bytes === undefined) continue
            const source = { rootId: layer.rootId, path: `${layer.sourcePath}/${file}`, documentIndex }
            documentIndex += 1
            for (const [key, value] of parseSc2Strings(decoder.decode(bytes))) strings.set(key, { value, ...source })
          }
        }
        return strings
      })()
      byLocale.set(locale, built)
      built.catch(() => { if (byLocale.get(locale) === built) byLocale.delete(locale) })
    }
    return built
  }

  return {
    invalidate(paths) {
      for (const path of paths) {
        const match = LOCALIZED_DATA.exec(path)
        if (match === null) continue
        // New unsaved localized files can introduce a locale used by fallback discovery.
        inputs = undefined
        if (STRING_FILES.has(path.slice(match[0].length).toLowerCase())) {
          byLocale.delete(`${match[1]!.toLowerCase()}${match[2]!.toUpperCase()}`)
        }
      }
    },
    async answer(request, contextLocales, signal) {
      const asked = stringsRequest(request)
      if (asked.keys.length === 0) return Object.freeze([])
      const chain = [
        ...new Set([...(asked.locales ?? contextLocales), 'enUS', ...(await stringInputs()).locales]),
      ]
      const requestedLocale = chain[0] as string
      const missing = new Set(asked.keys)
      const answer: DataLocalizedString[] = []
      for (const locale of chain) {
        if (missing.size === 0) break
        const strings = await localeStrings(locale)
        signal?.throwIfAborted()
        for (const key of missing) {
          const entry = strings.get(key)
          if (entry === undefined) continue
          missing.delete(key)
          answer.push(
            Object.freeze({
              key,
              requestedLocale,
              resolvedLocale: locale,
              value: entry.value,
              source: Object.freeze({ rootId: entry.rootId, path: entry.path, documentIndex: entry.documentIndex }),
              fallback: locale !== requestedLocale,
            }),
          )
        }
      }
      const order = new Map(asked.keys.map((key, index) => [key, index] as const))
      return Object.freeze(answer.sort((left, right) => order.get(left.key)! - order.get(right.key)!))
    },
  }
}
