/**
 * Command card icons of StarCraft II for an exporter (first consumer: the StarMine Minecraft mod, its
 * button table `dev/starmine/race/Sc2Buttons.java`, contract `docs/SC2_EXPORT.md` of hometlt/minecraft).
 * Owner: [SC2] Mod & Data.
 *
 * What it does, through one mod context (`ContentSources.openModContext`, the only path to mod content)
 * and its resolved Data (`data.entities`):
 * - {@link planCommandIcons}: each requested `CButton` id → its resolved `Icon` (`Assets\Textures\btn-*.dds`,
 *   the game's spelling) → the layer and path of that file in the context (`ModContext.locate`); a button
 *   the Data lacks, or whose icon no layer holds, is reported in `missing`, never replaced by another;
 * - {@link readCommandIcon}: the icon's bytes, read with a byte limit;
 * - {@link commandIconsJson}: the index the consumer ships beside the PNGs.
 *
 * It decodes nothing: the caller turns the DDS bytes into PNG through Modkit's image codec
 * (`scripts/export-starmine-icons.mjs`: `subject.convert --target png` of `extensions/images`).
 */

export interface DataEntity { readonly entityId: string; readonly fields?: Readonly<Record<string, unknown>> }

/** The structural part of `ModContext` the exporter uses. */
export interface IconExportContext {
  locate(path: string): Promise<{ readonly layerId: string; readonly path: string } | undefined>
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
  query(request: unknown): Promise<unknown>
}

export interface PlannedIcon {
  /** The `CButton` id (`MoveHoldPosition`). */
  readonly button: string
  /** Its `Icon` as the game spells it (`Assets\Textures\btn-command-holdposition.dds`). */
  readonly icon: string
  readonly layerId: string
  readonly path: string
}

export interface IconExportPlan {
  readonly icons: readonly PlannedIcon[]
  readonly missing: readonly { readonly button: string; readonly reason: string }[]
}

const BATCH = 1024

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Plans every button's icon file: Data answers which file, the context where it is. */
export async function planCommandIcons(context: IconExportContext, buttons: readonly string[]): Promise<IconExportPlan> {
  const wanted = [...new Set(buttons)]
  const rows = new Map<string, DataEntity>()
  for (let start = 0; start < wanted.length; start += BATCH) {
    const answer = await context.query({ kind: 'data.entities',
      refs: wanted.slice(start, start + BATCH).map(entityId => ({ namespace: 'Button', entityId })) })
    for (const row of isRecord(answer) && Array.isArray(answer['entities']) ? answer['entities'] as DataEntity[] : []) rows.set(row.entityId, row)
  }
  const icons: PlannedIcon[] = []
  const missing: { button: string; reason: string }[] = []
  for (const button of wanted) {
    const row = rows.get(button)
    const icon = row?.fields?.['Icon']
    if (row === undefined) { missing.push({ button, reason: 'no such Button in the context' }); continue }
    if (typeof icon !== 'string' || icon === '') { missing.push({ button, reason: 'the Button has no Icon' }); continue }
    const place = await context.locate(icon.replaceAll('\\', '/'))
    if (place === undefined) missing.push({ button, reason: `no layer holds ${icon}` })
    else icons.push({ button, icon, layerId: place.layerId, path: place.path })
  }
  return { icons, missing }
}

/** The bytes of a planned icon (a button icon is a few tens of KiB; the limit only guards the read). */
export function readCommandIcon(context: IconExportContext, icon: PlannedIcon, maxBytes = 4 << 20): Promise<Uint8Array> {
  return context.read(icon.layerId, icon.path, maxBytes)
}

/** The PNG name of a button below the consumer's icon folder: its id in lower case (`moveholdposition`). */
export const commandIconName = (button: string): string => button.toLowerCase()

/** The index shipped beside the PNGs: `{ <name>: { button, icon } }`, sorted by name. */
export function commandIconsJson(plan: Pick<IconExportPlan, 'icons'>): Record<string, { button: string; icon: string }> {
  const out: Record<string, { button: string; icon: string }> = {}
  for (const icon of [...plan.icons].sort((a, b) => commandIconName(a.button).localeCompare(commandIconName(b.button)))) {
    out[commandIconName(icon.button)] = { button: icon.button, icon: icon.icon }
  }
  return out
}
