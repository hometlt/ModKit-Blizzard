/**
 * Unit and ability sounds of StarCraft II for an exporter (first consumer: the StarMine Minecraft mod,
 * contract `docs/SC2_EXPORT.md` of hometlt/minecraft). Owner: [SC2] Mod & Data.
 *
 * What it does, all through one mod context (`ContentSources.openModContext`, the only path to mod
 * content) and its resolved Data (`data.entities`, `data.ids`):
 * - events per unit kind: `<kind>.fire` (weapon launch/impact sound, never a voice line), `<kind>.attack`,
 *   `<kind>.ambient`, `<kind>.hurt`, `<kind>.death` (voice lines and death sounds of the unit's actor),
 *   and `ability.<id>` (the cast sound of an ability);
 * - `fire` from Data: Unit.WeaponArray → Weapon.Effect/DisplayEffect → the effect tree → the actors on
 *   that effect's events (CActorAction LaunchAssets/ImpactMap, CActorSound Sound), the shot first;
 * - `ability.<id>` from Data: the SC2 abilities in {@link STARMINE_ABILITIES} → actors on
 *   `Abil.<abil>.<cast phase>`, then the ability's effect tree as for weapons;
 * - every event's candidates come in order (Data, then SC2's own CSound naming `<Unit>_AttackLaunch`,
 *   `<Unit>_Explode` …, then the explicit list); the first CSound that exists and has files wins —
 *   Data often names a CSound some patch removed;
 * - CSound → its `AssetArray` files (`File`, or `AssetArrayTemplate` filled with `TemplateParam`),
 *   located in the context (the context's locale first, `../core/voice-locale.ts`) and read with a
 *   byte limit; a file the chosen locale cannot give (offline CDN) falls back through
 *   {@link pickVoiceLocale} with a warning;
 * - {@link soundsJson}: Minecraft `sounds.json` (`starmine:sc2/<kind>/<event>_<n>`).
 *
 * It converts nothing: the caller turns the read bytes into mono Ogg Vorbis (ffmpeg of the host,
 * `scripts/export-starmine-sounds.mjs`). Events SC2 has no sound for are reported in `missing`, not
 * filled with another event's sound.
 */
import { localeOfPath, localizedAssetPath, pickVoiceLocale, SC2_LOCALES } from '../core/voice-locale.js'

export const UNIT_SOUND_EVENTS = Object.freeze(['fire', 'attack', 'death', 'ambient', 'hurt'] as const)
export type UnitSoundEvent = (typeof UNIT_SOUND_EVENTS)[number]

/** A StarMine kind id from its `UnitKind` enum name: lower case without underscores (`SIEGE_TANK` → `siegetank`). */
export function soundKindId(enumName: string): string {
  return enumName.toLowerCase().replaceAll('_', '')
}

export const unitEventName = (kind: string, event: UnitSoundEvent): string => `${kind}.${event}`
export const abilityEventName = (id: string): string => `ability.${id}`

/**
 * StarMine kinds whose SC2 unit id is not their own name (lower case, no underscores). Every other kind
 * is matched case-insensitively against the Unit ids of the context's Data.
 */
export const STARMINE_UNIT_IDS: Readonly<Record<string, string>> = Object.freeze({
  lurker: 'LurkerMP', swarmhost: 'SwarmHostMP', locust: 'LocustMP', viking: 'VikingFighter',
  templararchives: 'TemplarArchive',
})

/**
 * StarMine ability ids → the SC2 abilities that cast them (Data decides the sound) and CSounds tried
 * after Data (morphs, toggles and spells whose sound actor is created by another actor's `SoundDone`
 * chain or a generic `AbilMorph.*` event, so no event of the ability names it). The one hand-written
 * mapping of this module: StarMine's ids are its own names, not SC2 ids.
 */
export const STARMINE_ABILITIES: Readonly<Record<string, { readonly abil: readonly string[]; readonly sounds?: readonly string[] }>> = Object.freeze({
  burrow: { abil: ['BurrowRoachDown', 'BurrowZerglingDown', 'BurrowHydraliskDown'], sounds: ['Zerg_BurrowMedium', 'Zerg_BurrowSmall'] },
  corrosive_bile: { abil: ['RavagerCorrosiveBile'] },
  creep_tumor: { abil: ['QueenBuild', 'CreepTumorBuild'], sounds: ['CreepTumor_PlaceFlarp', 'CreepTumor_NewEmerge'] },
  inject_larva: { abil: ['SpawnLarva'] },
  transfusion: { abil: ['Transfusion'] },
  changeling: { abil: ['SpawnChangeling'], sounds: ['Overseer_SpawnChangeling'] },
  neural_parasite: { abil: ['NeuralParasite'] },
  fungal_growth: { abil: ['FungalGrowth'] },
  blinding_cloud: { abil: ['BlindingCloud'] },
  abduct: { abil: ['Yoink', 'ViperAbduct'] },
  parasitic_bomb: { abil: ['ParasiticBomb'] },
  consume: { abil: ['ViperConsume', 'ViperConsumeStructure'] },
  caustic_spray: { abil: ['CausticSpray'] },
  stimpack: { abil: ['Stimpack'] },
  kd8_charge: { abil: ['KD8Charge'], sounds: ['Reaper_D8ChargeAttackLaunch'] },
  cloak: { abil: ['GhostCloak', 'BansheeCloak'], sounds: ['Ghost_CloakOn', 'Terran_CloakOn'] },
  emp: { abil: ['EMP'] },
  steady_targeting: { abil: ['ChannelSnipe', 'Snipe'] },
  nuke: { abil: ['TacNukeStrike'] },
  hellbat: { abil: ['MorphToHellionTank'], sounds: ['HellionTankMorph_StandMorphStart_Stage00'] },
  siege_mode: { abil: ['SiegeMode'], sounds: ['SiegeTank_MorphToSiege'] },
  high_impact: { abil: ['ThorAPMode', 'ThorNormalMode'], sounds: ['Thor_250mmCannonMorph'] },
  viking_land: { abil: ['AssaultMode', 'FighterMode'], sounds: ['Viking_MorphToAssault'] },
  afterburners: { abil: ['MedivacSpeedBoost'], sounds: ['Medivac_IgniteAfterburners'] },
  yamato: { abil: ['Yamato'] },
  tactical_jump: { abil: ['Hyperjump'] },
  repair: { abil: ['Repair'], sounds: ['SCV_Repair'] },
  orbital_command: { abil: ['UpgradeToOrbital'], sounds: ['CommandCenter_UpgradeToOrbitalCommand'] },
  planetary_fortress: { abil: ['UpgradeToPlanetaryFortress'], sounds: ['CommandCenter_UpgradeToPlanetaryFortress'] },
  mule: { abil: ['CalldownMULE'], sounds: ['OrbitalCommand_CalldownMuleDrop'] },
  scanner_sweep: { abil: ['ScannerSweep'], sounds: ['OrbitalCommand_ScannerSweep'] },
  lower_depot: { abil: ['SupplyDepotLower'] },
  techlab: { abil: ['BarracksTechLabMorph', 'TechLabMorph'], sounds: ['TechLab_Birth'] },
  reactor: { abil: ['BarracksReactorMorph', 'ReactorMorph'], sounds: ['Reactor_Birth'] },
  lift_off: { abil: ['BarracksLiftOff', 'CommandCenterLiftOff'], sounds: ['TerranBuildingLiftOff'] },
  charge: { abil: ['Charge'], sounds: ['Zealot_Charge'] },
  blink: { abil: ['Blink'], sounds: ['Stalker_Blink'] },
  psionic_transfer: { abil: ['AdeptPhaseShift'] },
  force_field: { abil: ['ForceField'] },
  guardian_shield: { abil: ['GuardianShield'], sounds: ['Sentry_GuardianShieldLaunch'] },
  hallucination: { abil: ['HallucinationZealot', 'HallucinationStalker'], sounds: ['Sentry_HallucinationLaunchMedium'] },
  psionic_storm: { abil: ['PsiStorm'] },
  feedback: { abil: ['Feedback'] },
  archon_warp: { abil: ['ArchonWarp'] },
  shadow_stride: { abil: ['DarkTemplarBlink'] },
  purification_nova: { abil: ['PurificationNovaTargeted', 'PurificationNova'], sounds: ['Disruptor_DisruptionOvercharge_Start'] },
  phasing_mode: { abil: ['PhasingMode'], sounds: ['WarpPrism_MorphToPhasing'] },
  graviton_beam: { abil: ['GravitonBeam'], sounds: ['Phoenix_GravitonBeamStart'] },
  prismatic_alignment: { abil: ['VoidRaySwarmDamageBoost'], sounds: ['VoidRay_PrismaticAligntmentOn1'] },
  pulsar_beam: { abil: ['PulsarBeam', 'OracleWeapon'], sounds: ['Oracle_PulsarBeamModeOn'] },
  revelation: { abil: ['OracleRevelation'] },
  stasis_ward: { abil: ['OracleStasisTrapBuild', 'OracleStasisTrap'], sounds: ['Oracle_StasisTrap_Start'] },
  disintegration: { abil: ['TempestDisruptionBlast'] },
  mass_recall: { abil: ['MothershipMassRecall', 'NexusMassRecall'] },
  time_warp: { abil: ['TemporalField', 'TimeWarp'] },
  chrono_boost: { abil: ['ChronoBoostEnergyCost'] },
  battery_overcharge: { abil: ['BatteryOvercharge'], sounds: ['Nexus_BatteryOverchargeActivate'] },
  warp_gate: { abil: ['UpgradeToWarpGate', 'MorphBuildingGatewayWarpGateFree'], sounds: ['Gateway_MorphToWarpgate'] },
  // Hero abilities: the multiplayer Data has no heroes, the closest multiplayer casts are used.
  leaping_strike: { abil: ['KerriganLeapingStrike', 'LeapingStrike'], sounds: ['Zealot_Charge'] },
  psionic_shift: { abil: ['KerriganPsionicShift', 'PsionicShift'], sounds: ['DarkTemplar_Blink'] },
  hyperion_strike: { abil: ['Yamato'] },
  lightning_dash: { abil: ['ArtanisLightningDash', 'LightningDash'], sounds: ['Stalker_Blink'] },
  load: { abil: ['MedivacTransport', 'BunkerTransport'], sounds: ['Shuttle_Load', 'Overlord_Load'] },
  unload: { abil: ['MedivacTransport', 'BunkerTransport'], sounds: ['Shuttle_Unload', 'Overlord_Unload'] },
})

export interface DataEntity { readonly entityId: string; readonly fields?: Readonly<Record<string, unknown>> }

/** Sounds actors play on events: by full first term (`Effect.X.Start`) and by its subject (`Effect.X.*`). */
export type ActorSoundIndex = ReadonlyMap<string, readonly string[]>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Array fields resolve as `[{ index, value }]`; a single value is its own list. */
function entries(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value.map(item => isRecord(item) && 'value' in item ? item['value'] : item) : [value]
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

/**
 * The event index of every actor that plays a sound: the first term of each `On` event
 * (`Effect.GuassRifle.Start`, `Abil.Stimpack.SourceCastStart`) → its launch sound, then plain sound,
 * then impact sound; the same under `<Kind>.<Id>.*` for any event of that effect or ability.
 */
export function actorSoundIndex(actors: Iterable<DataEntity>): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const add = (key: string, sounds: readonly string[]) => {
    let slot = index.get(key)
    if (slot === undefined) index.set(key, slot = [])
    for (const sound of sounds) if (!slot.includes(sound)) slot.push(sound)
  }
  for (const actor of actors) {
    const fields = actor.fields ?? {}
    const launchAssets = fields['LaunchAssets']
    const sounds = [
      isRecord(launchAssets) ? text(launchAssets['Sound']) : undefined,
      text(fields['Sound']),
      ...entries(fields['ImpactMap']).map(item => isRecord(item) ? text(item['Sound']) : undefined),
    ].filter((sound): sound is string => sound !== undefined)
    if (!sounds.length) continue
    for (const on of entries(fields['On'])) {
      const term = isRecord(on) ? text(on['Terms'])?.split(';')[0]?.trim() : undefined
      if (term === undefined) continue
      add(term, sounds)
      const [kind, id] = term.split('.')
      if (id !== undefined && id !== '*') add(`${kind}.${id}.*`, sounds)
    }
  }
  return index
}

/** Every string in a value that names one of `known` (child effects of sets, missiles, persistents …). */
function linksIn(value: unknown, known: ReadonlySet<string>, out: string[]): void {
  if (typeof value === 'string') { if (known.has(value) && !out.includes(value)) out.push(value) }
  else if (Array.isArray(value)) for (const item of value) linksIn(item, known, out)
  else if (isRecord(value)) for (const item of Object.values(value)) linksIn(item, known, out)
}

export type EntityLookup = (namespace: string, ids: readonly string[]) => Promise<ReadonlyMap<string, DataEntity>>

const MAX_EFFECTS = 64
const MAX_EFFECT_DEPTH = 5

const push = (out: string[], sounds: readonly string[] | undefined) => {
  for (const sound of sounds ?? []) if (!out.includes(sound)) out.push(sound)
}

/** Sounds of an effect tree, breadth first from `roots`: each effect's `Start` actors, then its other events. */
async function effectTreeSounds(roots: readonly string[], index: ActorSoundIndex, effects: ReadonlySet<string>,
  lookup: EntityLookup, out: string[]): Promise<void> {
  const seen = new Set<string>()
  let frontier = roots.filter(id => effects.has(id))
  for (let depth = 0; depth < MAX_EFFECT_DEPTH && frontier.length && seen.size < MAX_EFFECTS; depth++) {
    for (const id of frontier) seen.add(id)
    for (const id of frontier) push(out, index.get(`Effect.${id}.Start`))
    for (const id of frontier) push(out, index.get(`Effect.${id}.*`))
    const rows = await lookup('Effect', frontier)
    const next: string[] = []
    for (const id of frontier) linksIn(rows.get(id)?.fields, effects, next)
    frontier = next.filter(id => !seen.has(id)).slice(0, MAX_EFFECTS - seen.size)
  }
}

const linkOf = (value: unknown): string | undefined => isRecord(value) ? text(value['Link']) : text(value)

/**
 * CSound candidates of a unit's weapon shots, in order: its weapons' effect trees (a hidden `…Fake`
 * weapon that only aims a turret also tries the weapon of its name without `Fake`), then SC2's own
 * naming `<Prefix>_AttackLaunch`, `<Prefix>_AttackImpact` ({@link soundPrefixes}).
 */
export async function weaponSounds(prefixes: readonly string[], unit: DataEntity | undefined, index: ActorSoundIndex,
  effects: ReadonlySet<string>, lookup: EntityLookup): Promise<string[]> {
  const out: string[] = []
  const weapons = entries(unit?.fields?.['WeaponArray']).map(linkOf).filter((id): id is string => id !== undefined)
  const all = weapons.flatMap(id => id.endsWith('Fake') ? [id, id.slice(0, -'Fake'.length)] : [id])
  const rows = await lookup('Weapon', all)
  for (const id of all) {
    const weapon = rows.get(id)?.fields
    const roots = [text(weapon?.['Effect']), text(weapon?.['DisplayEffect'])].filter((link): link is string => link !== undefined)
    await effectTreeSounds(roots, index, effects, lookup, out)
  }
  push(out, prefixes.flatMap(prefix => [`${prefix}_AttackLaunch`, `${prefix}_AttackImpact`]))
  return out
}

/** Cast phases in the order an ability's sound most often hangs on them. */
const CAST_PHASES = ['SourceCastStart', 'CastStart', 'TargetCastStart', 'SourcePrepStart', 'PrepStart', 'Cast', 'Start', 'Execute']

/** CSound candidates of an ability's cast: actors on its events, its effect tree, then the explicit list. */
export async function abilitySounds(abils: readonly string[], explicit: readonly string[], index: ActorSoundIndex,
  effects: ReadonlySet<string>, lookup: EntityLookup): Promise<string[]> {
  const out: string[] = []
  for (const abil of abils) for (const phase of CAST_PHASES) push(out, index.get(`Abil.${abil}.${phase}`))
  for (const abil of abils) push(out, index.get(`Abil.${abil}.*`))
  const rows = await lookup('Abil', abils)
  for (const abil of abils) {
    const roots: string[] = []
    linksIn(rows.get(abil)?.fields?.['Effect'], effects, roots)
    await effectTreeSounds(roots, index, effects, lookup, out)
  }
  push(out, explicit)
  return out
}

/**
 * The prefixes SC2 names a unit's CSounds with: its id, the id without the multiplayer `MP` suffix
 * (`LurkerMP` → `Lurker`) and the prefix of its actor's voice links (`SwarmHost_What` → `SwarmHost`).
 */
export function soundPrefixes(unitId: string, actor: DataEntity | undefined): string[] {
  const out = [unitId]
  if (unitId.endsWith('MP')) out.push(unitId.slice(0, -2))
  for (const item of entries(actor?.fields?.['SoundArray'])) {
    const link = text(item)
    const prefix = link?.includes('_') ? link.slice(0, link.indexOf('_')) : undefined
    if (prefix !== undefined && !out.includes(prefix)) out.push(prefix)
  }
  return out
}

/**
 * Voice and death CSound candidates of a unit's actor: its `SoundArray` / `DeathArray[Normal]` links in
 * each event's preference order (attack: Attack, Yes; ambient: What, Ready; hurt: Pissed, Help; death:
 * the death sound, the death voice), then SC2's naming `<Prefix>_<Line>` (buildings' `<Prefix>_Explode`).
 */
export function voiceSounds(prefixes: readonly string[], actor: DataEntity | undefined): Record<Exclude<UnitSoundEvent, 'fire'>, string[]> {
  const array = new Map<string, string>()
  for (const item of Array.isArray(actor?.fields?.['SoundArray']) ? actor.fields['SoundArray'] as unknown[] : []) {
    if (isRecord(item) && typeof item['index'] === 'string') {
      const link = text(item['value'])
      if (link !== undefined) array.set(item['index'], link)
    }
  }
  const deaths = Array.isArray(actor?.fields?.['DeathArray']) ? actor.fields['DeathArray'] as unknown[] : []
  const death = deaths.find(item => isRecord(item) && item['index'] === 'Normal')
  const deathValue = isRecord(death) && isRecord(death['value']) ? death['value'] : {}
  const lines = (...names: string[]) => [...names.map(name => array.get(name)), ...prefixes.flatMap(prefix => names.map(name => `${prefix}_${name}`))]
  const list = (...links: (string | undefined)[]) => [...new Set(links.filter((link): link is string => link !== undefined))]
  return {
    attack: list(...lines('Attack', 'Yes')),
    ambient: list(...lines('What', 'Ready')),
    hurt: list(...lines('Pissed', 'Help')),
    death: list(text(deathValue['SoundLink']), text(deathValue['VoiceLink']), ...prefixes.flatMap(prefix => [`${prefix}_Death`, `${prefix}_Explode`])),
  }
}

/** A CSound's files in asset order: `File`, or the `AssetArrayTemplate` file filled with `TemplateParam`. */
export function soundFiles(sound: DataEntity): string[] {
  const template = sound.fields?.['AssetArrayTemplate']
  const templateFile = isRecord(template) ? text(template['File']) : undefined
  const files: string[] = []
  for (const asset of entries(sound.fields?.['AssetArray'])) {
    let file = isRecord(asset) ? text(asset['File']) : text(asset)
    const param = isRecord(asset) ? text(asset['TemplateParam']) : undefined
    if (file === undefined && templateFile !== undefined && param !== undefined) {
      // `^TemplateParamN^` takes the N-th comma-separated value; a single value fills every slot.
      const values = param.split(',')
      file = templateFile.replace(/\^TemplateParam(\d+)\^/gu, (_match, n: string) => values[Number(n) - 1] ?? values[values.length - 1] ?? '')
    }
    if (file !== undefined && !files.includes(file)) files.push(file)
  }
  return files
}

/** The structural part of `ModContext` the exporter uses. */
export interface SoundExportContext {
  locate(path: string): Promise<{ readonly layerId: string; readonly path: string } | undefined>
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
  query(request: unknown): Promise<unknown>
}

export interface PlannedSound {
  /** Name below `sounds/` without extension: `sc2/marine/fire_0`. */
  readonly name: string
  /** The CSound it comes from and its file as the game spells it. */
  readonly sound: string
  readonly gamePath: string
  readonly layerId: string
  readonly path: string
}

export interface SoundExportPlan {
  readonly events: Readonly<Record<string, readonly PlannedSound[]>>
  /** Events SC2 has no sound for (or whose files no layer holds), with the reason. */
  readonly missing: readonly { readonly event: string; readonly reason: string }[]
}

export interface SoundExportRequest {
  /** StarMine kind ids (`siegetank`). */
  readonly kinds: readonly string[]
  /** StarMine ability ids (`psionic_storm`). */
  readonly abilities: readonly string[]
  /** Files kept per event (SC2 has up to ~20 variations per line). */
  readonly maxFilesPerEvent?: number
}

const BATCH = 1024

/** Plans every event's files: Data answers which CSounds, the context where their files are. */
export async function planUnitSounds(context: SoundExportContext, request: SoundExportRequest): Promise<SoundExportPlan> {
  const cache = new Map<string, DataEntity | null>()
  const lookup: EntityLookup = async (namespace, ids) => {
    const wanted = [...new Set(ids)].filter(id => !cache.has(`${namespace}:${id}`))
    for (let start = 0; start < wanted.length; start += BATCH) {
      const slice = wanted.slice(start, start + BATCH)
      const answer = await context.query({ kind: 'data.entities', refs: slice.map(entityId => ({ namespace, entityId })) })
      const rows = isRecord(answer) && Array.isArray(answer['entities']) ? answer['entities'] as DataEntity[] : []
      for (const id of slice) cache.set(`${namespace}:${id}`, null)
      for (const row of rows) cache.set(`${namespace}:${row.entityId}`, row)
    }
    const found = new Map<string, DataEntity>()
    for (const id of ids) { const row = cache.get(`${namespace}:${id}`); if (row) found.set(id, row) }
    return found
  }
  const idsOf = async (namespace: string): Promise<string[]> => {
    const answer = await context.query({ kind: 'data.ids', namespace })
    return isRecord(answer) && Array.isArray(answer['ids']) ? answer['ids'] as string[] : []
  }
  const [unitIds, actorIds, effectIds, soundIds] = await Promise.all(['Unit', 'Actor', 'Effect', 'Sound'].map(idsOf)) as [string[], string[], string[], string[]]
  const effects = new Set(effectIds), soundSet = new Set(soundIds)
  const index = actorSoundIndex((await lookup('Actor', actorIds)).values())
  const unitByName = new Map(unitIds.map(id => [id.toLowerCase(), id]))
  const units = new Map(request.kinds.map(kind => [kind, STARMINE_UNIT_IDS[kind] ?? unitByName.get(kind)]))
  const unitRows = await lookup('Unit', [...units.values()].filter((id): id is string => id !== undefined))

  const candidates = new Map<string, string[]>()
  const missing: { event: string; reason: string }[] = []
  for (const [kind, unitId] of units) {
    if (unitId === undefined || !unitRows.has(unitId)) {
      for (const event of UNIT_SOUND_EVENTS) missing.push({ event: unitEventName(kind, event), reason: 'no SC2 unit of this kind in the context' })
      continue
    }
    const actor = (await lookup('Actor', [unitId])).get(unitId)
    const prefixes = soundPrefixes(unitId, actor)
    const voices = voiceSounds(prefixes, actor)
    for (const event of UNIT_SOUND_EVENTS) {
      candidates.set(unitEventName(kind, event), event === 'fire'
        ? await weaponSounds(prefixes, unitRows.get(unitId), index, effects, lookup) : voices[event])
    }
  }
  for (const id of request.abilities) {
    const spec = STARMINE_ABILITIES[id]
    if (spec === undefined) missing.push({ event: abilityEventName(id), reason: 'no SC2 ability mapped' })
    else candidates.set(abilityEventName(id), await abilitySounds(spec.abil, spec.sounds ?? [], index, effects, lookup))
  }

  const soundRows = await lookup('Sound', [...new Set([...candidates.values()].flat())].filter(link => soundSet.has(link)))
  const limit = request.maxFilesPerEvent ?? 6
  const events: Record<string, PlannedSound[]> = {}
  for (const [event, links] of candidates) {
    const ability = event.startsWith('ability.')
    const folder = ability ? 'ability' : event.slice(0, event.indexOf('.'))
    const base = ability ? event.slice('ability.'.length) : event.slice(event.indexOf('.') + 1)
    for (const link of links) {
      const row = soundRows.get(link)
      if (row === undefined) continue
      const planned: PlannedSound[] = []
      for (const gamePath of soundFiles(row)) {
        if (planned.length >= limit) break
        const place = await context.locate(gamePath.replaceAll('\\', '/'))
        if (place !== undefined) planned.push({ name: `sc2/${folder}/${base}_${planned.length}`, sound: link, gamePath, layerId: place.layerId, path: place.path })
      }
      if (planned.length) { events[event] = planned; break }
    }
    if (events[event] === undefined) {
      missing.push({ event, reason: links.length ? `no CSound with files among ${links.slice(0, 4).join(', ')}` : 'SC2 names no sound for it' })
    }
  }
  return { events, missing }
}

/**
 * The bytes of a planned sound in the voice locale: the located file if it is not localized, else the
 * voice locale's copy; a locale the source cannot give falls back to the best other
 * ({@link pickVoiceLocale}), reported through `warn`.
 */
export async function readUnitSound(context: SoundExportContext, sound: PlannedSound, voiceLocale: string,
  warn: (message: string) => void, maxBytes = 16 << 20): Promise<{ readonly bytes: Uint8Array; readonly locale?: string }> {
  if (localeOfPath(sound.path) === undefined) return { bytes: await context.read(sound.layerId, sound.path, maxBytes) }
  const failures: string[] = []
  const order = [voiceLocale]
  for (let rest = SC2_LOCALES.filter(locale => locale !== voiceLocale); rest.length;) {
    const next = pickVoiceLocale(voiceLocale, rest)
    if (next === undefined) break
    order.push(next)
    rest = rest.filter(locale => locale !== next)
  }
  for (const locale of order) {
    try {
      const bytes = await context.read(sound.layerId, localizedAssetPath(sound.path, locale), maxBytes)
      if (locale !== voiceLocale) warn(`${sound.gamePath}: no ${voiceLocale} copy (${failures.join('; ')}), took ${locale}`)
      return { bytes, locale }
    } catch (error) {
      failures.push(`${locale}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`${sound.gamePath}: no locale could be read (${failures.slice(0, 3).join('; ')})`)
}

/** Minecraft `sounds.json` for the planned events (`namespace` is the mod id). */
export function soundsJson(plan: Pick<SoundExportPlan, 'events'>, namespace = 'starmine'): Record<string, { subtitle: string; sounds: string[] }> {
  const out: Record<string, { subtitle: string; sounds: string[] }> = {}
  for (const event of Object.keys(plan.events).sort()) {
    out[event] = { subtitle: `subtitles.${namespace}.${event}`, sounds: (plan.events[event] ?? []).map(sound => `${namespace}:${sound.name}`) }
  }
  return out
}
