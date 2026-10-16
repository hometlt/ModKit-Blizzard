/**
 * The language of a game's voices and other localized assets (owner's request for StarMine, 2026-10-16:
 * voices in English by default, the language a choice at install).
 *
 * StarCraft II keeps localized assets per locale (`<locale>.SC2Assets/…`, `<locale>.SC2Data/…`). A
 * partial installation stores only its own locale's files but its CASC root still names every
 * locale's, so an exporter that asks for `enUS.SC2Assets/…` on a German install gets them from the CDN
 * (an online installation, `casc/src/casc/installation.ts`). An exporter therefore picks a voice locale
 * (`--voice-locale=enUS`, or `MODKIT_VOICE_LOCALE`; enUS when none is given), opens its mod context with
 * that locale first (`ModContextRequest.locales`: `ModContext.locate` then prefers that locale's
 * `.SC2Assets`; without it the components come in alphabetical order and deDE wins) and maps any
 * localized path it reads to that locale with {@link localizedAssetPath}.
 *
 * The locale table itself has one owner, the strings module (`strings/shared/core/constants.ts`).
 */
import { canonicalLocale, SC2_LOCALES as LOCALE_TABLE } from '../../../strings/shared/core/constants.js'

/** StarCraft II's locale ids (`enUS`, `deDE`, …), in the strings module's order. */
export const SC2_LOCALES: readonly string[] = Object.freeze(LOCALE_TABLE.map(locale => locale.id))

export const DEFAULT_VOICE_LOCALE = 'enUS'

/** A locale code in its canonical case (`DEDE`, `de-de` → `deDE`), or undefined if StarCraft II has no such locale. */
export function canonicalSc2Locale(code: string | undefined): string | undefined {
  return code === undefined ? undefined : canonicalLocale(code.trim().replace(/[-_]/gu, ''))
}

const LOCALIZED_SEGMENT = /(^|[\\/])([a-z]{2}[a-z]{2})(\.sc2(?:assets|data))(?=[\\/]|$)/giu

/**
 * The same asset in another locale: the `<locale>.SC2Assets` or `<locale>.SC2Data` segment of `path`
 * (any case) set to `locale`, keeping the segment's own case style (all lower stays lower). A path with
 * no localized segment (`Base.SC2Assets/…`, `Assets/…`) is returned as it is.
 */
export function localizedAssetPath(path: string, locale: string): string {
  return path.replace(LOCALIZED_SEGMENT, (match, lead: string, code: string, suffix: string) => {
    if (canonicalSc2Locale(code) === undefined) return match
    const lower = code === code.toLowerCase() && suffix === suffix.toLowerCase()
    return lead + (lower ? locale.toLowerCase() : locale) + suffix
  })
}

/** The locale a localized path is in, or undefined. */
export function localeOfPath(path: string): string | undefined {
  for (const match of path.matchAll(LOCALIZED_SEGMENT)) {
    const locale = canonicalSc2Locale(match[2])
    if (locale !== undefined) return locale
  }
  return undefined
}

/**
 * The voice locale an exporter uses: `--voice-locale=xxXX` (or `--voice-locale xxXX`) among `argv`,
 * else the environment's `MODKIT_VOICE_LOCALE`, else enUS. An unknown code is an error, not a silent
 * fallback (a typo would otherwise export the wrong language).
 */
export function voiceLocaleFrom(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): string {
  let given: string | undefined
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--voice-locale=')) given = arg.slice('--voice-locale='.length)
    else if (arg === '--voice-locale') given = argv[index + 1]
  }
  given ??= env['MODKIT_VOICE_LOCALE']
  if (given === undefined || given === '') return DEFAULT_VOICE_LOCALE
  const locale = canonicalSc2Locale(given)
  if (locale === undefined) throw new Error(`Unknown StarCraft II voice locale "${given}"; one of ${SC2_LOCALES.join(', ')}`)
  return locale
}

/**
 * The best of the locales a source holds for a wanted one: the wanted locale, else enUS, else the first
 * held (an exporter that cannot reach the CDN still exports something, and says which).
 */
export function pickVoiceLocale(wanted: string, held: readonly string[]): string | undefined {
  const locales = held.map(canonicalSc2Locale).filter((locale): locale is string => locale !== undefined)
  if (locales.includes(wanted)) return wanted
  if (locales.includes(DEFAULT_VOICE_LOCALE)) return DEFAULT_VOICE_LOCALE
  return locales[0]
}
