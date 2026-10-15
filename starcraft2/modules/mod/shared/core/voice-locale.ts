/**
 * The language of a game's voices and other localized assets (owner's request for StarMine, 2026-10-16:
 * voices in English by default, the language a choice at install).
 *
 * StarCraft II keeps localized assets per locale (`<locale>.SC2Assets/…`, `<locale>.SC2Data/…`). A
 * partial installation stores only its own locale's files but its CASC root still names every
 * locale's, so an exporter that asks for `enUS.SC2Assets/…` on a German install gets them from the CDN
 * (an online installation, `casc/src/casc/installation.ts`). An exporter therefore picks a voice locale
 * (`--voice-locale=enUS`, or `MODKIT_VOICE_LOCALE`; enUS when none is given) and maps every localized
 * path it reads to that locale with {@link localizedAssetPath}.
 */

/** StarCraft II's locales. */
export const SC2_LOCALES = Object.freeze([
  'enUS', 'enGB', 'deDE', 'esES', 'esMX', 'frFR', 'itIT', 'koKR', 'plPL', 'ptBR', 'ruRU', 'zhCN', 'zhTW',
] as const)

export type Sc2Locale = (typeof SC2_LOCALES)[number]

export const DEFAULT_VOICE_LOCALE: Sc2Locale = 'enUS'

/** A locale code in its canonical case (`DEDE` → `deDE`), or undefined if StarCraft II has no such locale. */
export function canonicalSc2Locale(code: string | undefined): Sc2Locale | undefined {
  if (code === undefined) return undefined
  const wanted = code.trim().replace(/[-_]/gu, '').toLowerCase()
  return SC2_LOCALES.find(locale => locale.toLowerCase() === wanted)
}

const LOCALIZED_SEGMENT = /(^|[\\/])([a-z]{2}[a-z]{2})(\.sc2(?:assets|data))(?=[\\/]|$)/giu

/**
 * The same asset in another locale: the `<locale>.SC2Assets` or `<locale>.SC2Data` segment of `path`
 * (any case) set to `locale`, keeping the segment's own case style (all lower stays lower). A path with
 * no localized segment (`Base.SC2Assets/…`, `Assets/…`) is returned as it is.
 */
export function localizedAssetPath(path: string, locale: Sc2Locale): string {
  return path.replace(LOCALIZED_SEGMENT, (match, lead: string, code: string, suffix: string) => {
    if (canonicalSc2Locale(code) === undefined) return match
    const lower = code === code.toLowerCase() && suffix === suffix.toLowerCase()
    return lead + (lower ? locale.toLowerCase() : locale) + suffix
  })
}

/** The locale a localized path is in, or undefined. */
export function localeOfPath(path: string): Sc2Locale | undefined {
  LOCALIZED_SEGMENT.lastIndex = 0
  const match = LOCALIZED_SEGMENT.exec(path)
  LOCALIZED_SEGMENT.lastIndex = 0
  return match ? canonicalSc2Locale(match[2]) : undefined
}

/**
 * The voice locale an exporter uses: `--voice-locale=xxXX` (or `--voice-locale xxXX`) among `argv`,
 * else the environment's `MODKIT_VOICE_LOCALE`, else enUS. An unknown code is an error, not a silent
 * fallback (a typo would otherwise export the wrong language).
 */
export function voiceLocaleFrom(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): Sc2Locale {
  let given: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--voice-locale=')) given = arg.slice('--voice-locale='.length)
    else if (arg === '--voice-locale') given = argv[i + 1]
  }
  given ??= env.MODKIT_VOICE_LOCALE
  if (given === undefined || given === '') return DEFAULT_VOICE_LOCALE
  const locale = canonicalSc2Locale(given)
  if (locale === undefined) throw new Error(`Unknown StarCraft II voice locale "${given}"; one of ${SC2_LOCALES.join(', ')}`)
  return locale
}

/**
 * The best of the locales a source holds for a wanted one: the wanted locale, else enUS, else the first
 * held (an exporter that cannot reach the CDN still exports something, and says which).
 */
export function pickVoiceLocale(wanted: Sc2Locale, held: readonly string[]): Sc2Locale | undefined {
  const locales = held.map(canonicalSc2Locale).filter((locale): locale is Sc2Locale => locale !== undefined)
  if (locales.includes(wanted)) return wanted
  if (locales.includes(DEFAULT_VOICE_LOCALE)) return DEFAULT_VOICE_LOCALE
  return locales[0]
}
