/**
 * SC2 locale and string-file constants. Ported from old-modkit-ts
 * (`core.locales.js` and `TextData.Strings.js` STRING_CATALOGS).
 */

export interface SC2Locale {
  /** SC2 locale id, e.g. "enUS". */
  id: string
  /** Native display name. */
  name: string
  /** ISO 639-1 (or BCP-47) code for translation engines. */
  iso639: string
  /** Languages without spaces between words (CJK/Korean). */
  wordBreak?: boolean
}

/** The 13 SC2 locales. */
export const SC2_LOCALES: readonly SC2Locale[] = [
  { id: 'enUS', name: 'English', iso639: 'en' },
  { id: 'enGB', name: 'English (GB)', iso639: 'en' },
  { id: 'frFR', name: 'Français', iso639: 'fr' },
  { id: 'deDE', name: 'Deutsch', iso639: 'de' },
  { id: 'esES', name: 'Español (ES)', iso639: 'es' },
  { id: 'esMX', name: 'Español (AL)', iso639: 'es' },
  { id: 'ruRU', name: 'Русский', iso639: 'ru' },
  { id: 'koKR', name: '한국어', iso639: 'ko', wordBreak: true },
  { id: 'zhCN', name: '简体中文', iso639: 'zh-CN', wordBreak: true },
  { id: 'zhTW', name: '繁體中文', iso639: 'zh-TW', wordBreak: true },
  { id: 'plPL', name: 'Polski', iso639: 'pl' },
  { id: 'itIT', name: 'Italiano', iso639: 'it' },
  { id: 'ptBR', name: 'Português (BR)', iso639: 'pt' },
] as const

const LOCALE_BY_ID = new Map(SC2_LOCALES.map((l) => [l.id.toLowerCase(), l]))

/** Canonical locale id from any case (e.g. "dede" → "deDE"); undefined if unknown. */
export function canonicalLocale(code: string): string | undefined {
  return LOCALE_BY_ID.get(code.toLowerCase())?.id
}

/** Look up a locale descriptor by id (case-insensitive). */
export function localeInfo(code: string): SC2Locale | undefined {
  return LOCALE_BY_ID.get(code.toLowerCase())
}

const LOCALE_TAG_RE = /<Locale\b([^>]*?)\/?>/gi
const ATTR_RE = /\b([A-Za-z]+)\s*=\s*"([^"]*)"/g

/**
 * Parse a `Base.SC2Data/Index.SC2Locale` file (present in Core.SC2Mod, and
 * searchable across a mod's dependency chain like any other file) into locale
 * descriptors — the authoritative, non-hardcoded source for which locales a
 * given game/mod build actually supports.
 */
export function parseIndexSc2Locale(xml: string): SC2Locale[] {
  const out: SC2Locale[] = []
  let m: RegExpExecArray | null
  LOCALE_TAG_RE.lastIndex = 0
  while ((m = LOCALE_TAG_RE.exec(xml)) !== null) {
    const attrs: Record<string, string> = {}
    let am: RegExpExecArray | null
    ATTR_RE.lastIndex = 0
    while ((am = ATTR_RE.exec(m[1]!)) !== null) attrs[am[1]!.toLowerCase()] = am[2]!
    const id = attrs['id']
    const name = attrs['name']
    if (!id || !name) continue
    // Prefer the known iso639 for a recognized id; best-effort fallback (the id's
    // language prefix, e.g. "enUS" → "en") for a locale this build doesn't know about.
    const locale: SC2Locale = { id, name, iso639: localeInfo(id)?.iso639 ?? id.slice(0, 2).toLowerCase() }
    if (attrs['wordbreak'] === '1') locale.wordBreak = true
    out.push(locale)
  }
  return out
}

/**
 * Canonical localized string file names (without `.txt`). The first three are the
 * primary author-facing files; the rest are editor/hint catalogs.
 */
export const STRING_CATALOGS: readonly string[] = [
  'GameStrings', 'GameStringsProduct',
  'ObjectStrings', 'ObjectStringsProduct',
  'TriggerStrings',
  'ConversationStrings',
  'GameHotkeys', 'GameHotkeysProduct',
  'Errors',
  // editor catalogs
  'Editor/EditorCatalogStrings', 'Editor/EditorCatalogStringsSC2',
  'Editor/EditorCategoryStrings', 'Editor/EditorStrings', 'Editor/EditorStringsSC2',
  // hint catalogs (per data namespace)
  'AbilHints', 'AccumulatorHints', 'AchievementHints', 'AchievementTermHints',
  'ActorHints', 'ActorSupportHints', 'AlertHints', 'ArmyCategoryHints', 'ArmyUnitHints',
  'ArmyUpgradeHints', 'ArtifactHints', 'ArtifactSlotHints', 'AttachMethodHints',
  'BankConditionHints', 'BeamHints', 'BehaviorHints', 'BoostHints', 'BundleHints',
  'ButtonHints', 'CameraHints', 'CampaignHints', 'CharacterHints', 'CliffHints',
  'CliffmeshHints', 'ColorStyleHints', 'CommanderHints', 'ConfigHints', 'ConsoleSkinHints',
  'ConversationHints', 'ConversationStateHints', 'CursorHints', 'DatacollectionHints',
  'DatacollectionPatternHints', 'DecalpackHints', 'DspHints', 'EffectHints', 'EmoticonHints',
  'EmoticonpackHints', 'ErrorHints', 'FootprintHints', 'FowHints', 'GameHints', 'GameUIHints',
  'HerdHints', 'HerdNodeHints', 'HeroAbilHints', 'HeroHints', 'HeroStatHints', 'ItemClassHints',
  'ItemContainerHints', 'ItemHints', 'KineticHints', 'LensFlareSetHints', 'LightHints',
  'LocationHints', 'LootHints', 'MapHints', 'ModelHints', 'MountHints', 'MoverHints',
  'ObjectiveHints', 'PhysicsMaterialHints', 'PingHints', 'PlayerResponseHints',
  'PortraitPackHints', 'PreloadHints', 'PremiumMapHints', 'RaceBannerPackHints', 'RaceHints',
  'RequirementHints', 'RequirementNodeHints', 'ReverbHints', 'RewardHints', 'ScoreResultHints',
  'ScoreValueHints', 'ShapeHints', 'SkinHints', 'SkinPackHints', 'SoundExclusivityHints',
  'SoundHints', 'SoundMixSnapshotHints', 'SoundtrackHints', 'SprayHints', 'SprayPackHints',
  'StimpackHints', 'TacCooldownHints', 'TacticalHints', 'TalentHints', 'TalentProfileHints',
  'TargetFindHints', 'TargetSortHints', 'TerrainHints', 'TerrainObjectHints', 'TerrainTexHints',
  'TextureHints', 'TextureSheetHints', 'TileHints', 'TrophyHints', 'TurretHints', 'UnitHints',
  'UpgradeHints', 'UserHints', 'ValidatorHints', 'VoiceoverHints', 'VoicepackHints',
  'WarchestHints', 'WarChestSeasonHints', 'WaterHints', 'WeaponHints',
] as const

/** Whether a locale file stem is one of the catalogs the game ships. */
export function isStringCatalog(stem: string): boolean {
  const lc = stem.toLowerCase()
  return STRING_CATALOGS.some(name => name.toLowerCase() === lc)
}

/** Normalise a locale file stem to canonical PascalCase (e.g. "gamestrings" → "GameStrings"). */
export function canonicalStringFile(stem: string): string {
  const lc = stem.toLowerCase()
  for (const name of STRING_CATALOGS) {
    if (name.toLowerCase() === lc) return name
  }
  return stem
}
