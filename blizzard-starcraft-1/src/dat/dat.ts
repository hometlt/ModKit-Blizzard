/**
 * StarCraft data tables (`arr\*.dat`): each file is a run of columns, one field for every entry of
 * the table, stored one after another. A field is 1, 2 or 4 bytes (little-endian) per entry, some are
 * a pair or four of them (a placement box, unit extents), and a few cover only a range of entries
 * (only buildings have an addon position, only the original units voices). Nothing in a file says
 * where a column ends, so a file is read only when its size is exactly its layout's: a modded or
 * extended table is refused rather than misread.
 *
 * Layouts are Brood War's (StarCraft 1.16 through Remastered). A column's name is the field's
 * meaning; raw values are kept (hit points and shields as the game stores them).
 */

export interface DatField {
  readonly name: string
  readonly bytes: 1 | 2 | 4
  /** Values per entry: 2 for a width/height pair, 4 for extents. */
  readonly parts?: number
  /** The entries the field covers: from `first`, `count` of them. The whole table by default. */
  readonly first?: number
  readonly count?: number
}

/** Where an entry's display name comes from. */
export type DatNames =
  /** `rez\stat_txt.tbl`, the entry's own index (0-based): units. */
  | { readonly kind: 'stat_txt-by-index' }
  /** `rez\stat_txt.tbl`, the 1-based id in `field`: weapons, upgrades, technologies. */
  | { readonly kind: 'stat_txt'; readonly field: string }
  /** The table's own `arr\<file>.tbl`, the 1-based id in `field`: images, sounds, portraits, missions. */
  | { readonly kind: 'own-tbl'; readonly field: string }

export interface DatLayout {
  readonly file: string
  readonly label: string
  readonly entries: number
  readonly fields: readonly DatField[]
  readonly names?: DatNames
}

const f = (name: string, bytes: DatField['bytes'], range: Omit<DatField, 'name' | 'bytes'> = {}): DatField => ({ name, bytes, ...range })
const UNITS = 228
/** Only buildings (106–201) have an infestation result and an addon position. */
const BUILDINGS = { first: 106, count: 96 }
/** Only the original units (0–105) have ready, annoyed and yes voices. */
const VOICED = { first: 0, count: 106 }
const SPRITES = 517
/** Only sprites from 130 on have a health bar and a selection circle. */
const SELECTABLE = { first: 130, count: 387 }

export const DAT_LAYOUTS: readonly DatLayout[] = Object.freeze([
  {
    file: 'units.dat',
    label: 'Units',
    entries: UNITS,
    names: { kind: 'stat_txt-by-index' },
    fields: [
      f('flingy', 1), f('subunit1', 2), f('subunit2', 2), f('infestation', 2, BUILDINGS), f('constructionImage', 4),
      f('direction', 1), f('shieldsEnabled', 1), f('shields', 2), f('hitPoints', 4), f('elevation', 1), f('movementFlags', 1),
      f('rank', 1), f('aiComputerIdle', 1), f('aiHumanIdle', 1), f('aiReturnToIdle', 1), f('aiAttackUnit', 1), f('aiAttackMove', 1),
      f('groundWeapon', 1), f('maxGroundHits', 1), f('airWeapon', 1), f('maxAirHits', 1), f('aiInternal', 1), f('specialAbilityFlags', 4),
      f('targetAcquisitionRange', 1), f('sightRange', 1), f('armorUpgrade', 1), f('unitSize', 1), f('armor', 1), f('rightClickAction', 1),
      f('readySound', 2, VOICED), f('whatSoundStart', 2), f('whatSoundEnd', 2), f('annoyedSoundStart', 2, VOICED), f('annoyedSoundEnd', 2, VOICED),
      f('yesSoundStart', 2, VOICED), f('yesSoundEnd', 2, VOICED), f('placementBox', 2, { parts: 2 }), f('addonPosition', 2, { parts: 2, ...BUILDINGS }),
      f('extents', 2, { parts: 4 }), f('portrait', 2), f('mineralCost', 2), f('vespeneCost', 2), f('buildTime', 2), f('requirements', 2),
      f('editorGroupFlags', 1), f('supplyProvided', 1), f('supplyRequired', 1), f('spaceRequired', 1), f('spaceProvided', 1),
      f('buildScore', 2), f('destroyScore', 2), f('mapString', 2), f('broodWar', 1), f('editorAvailabilityFlags', 2),
    ],
  },
  {
    file: 'weapons.dat',
    label: 'Weapons',
    entries: 130,
    names: { kind: 'stat_txt', field: 'label' },
    fields: [
      f('label', 2), f('flingy', 4), f('unused', 1), f('targetFlags', 2), f('minimumRange', 4), f('maximumRange', 4), f('damageUpgrade', 1),
      f('weaponType', 1), f('behavior', 1), f('removeAfter', 1), f('explosionType', 1), f('innerSplash', 2), f('mediumSplash', 2),
      f('outerSplash', 2), f('damage', 2), f('damageBonus', 2), f('cooldown', 1), f('damageFactor', 1), f('attackAngle', 1),
      f('launchSpin', 1), f('forwardOffset', 1), f('upwardOffset', 1), f('targetErrorMessage', 2), f('icon', 2),
    ],
  },
  {
    file: 'flingy.dat',
    label: 'Flingies',
    entries: 209,
    fields: [f('sprite', 2), f('topSpeed', 4), f('acceleration', 2), f('haltDistance', 4), f('turnRadius', 1), f('unused', 1), f('movementControl', 1)],
  },
  {
    file: 'sprites.dat',
    label: 'Sprites',
    entries: SPRITES,
    fields: [
      f('image', 2), f('healthBar', 1, SELECTABLE), f('unknown', 1), f('visible', 1), f('selectionCircle', 1, SELECTABLE),
      f('selectionCircleOffset', 1, SELECTABLE),
    ],
  },
  {
    file: 'images.dat',
    label: 'Images',
    entries: 999,
    names: { kind: 'own-tbl', field: 'grp' },
    fields: [
      f('grp', 4), f('graphicTurns', 1), f('clickable', 1), f('useFullIscript', 1), f('drawIfCloaked', 1), f('drawFunction', 1),
      f('remapping', 1), f('iscript', 4), f('shieldOverlay', 4), f('attackOverlay', 4), f('damageOverlay', 4), f('specialOverlay', 4),
      f('landingDustOverlay', 4), f('liftOffOverlay', 4),
    ],
  },
  {
    file: 'upgrades.dat',
    label: 'Upgrades',
    entries: 61,
    names: { kind: 'stat_txt', field: 'label' },
    fields: [
      f('mineralCostBase', 2), f('mineralCostFactor', 2), f('vespeneCostBase', 2), f('vespeneCostFactor', 2), f('researchTimeBase', 2),
      f('researchTimeFactor', 2), f('unknown', 2), f('icon', 2), f('label', 2), f('race', 1), f('maxRepeats', 1), f('broodWar', 1),
    ],
  },
  {
    file: 'techdata.dat',
    label: 'Technologies',
    entries: 44,
    names: { kind: 'stat_txt', field: 'label' },
    fields: [
      f('mineralCost', 2), f('vespeneCost', 2), f('researchTime', 2), f('energyRequired', 2), f('unknown', 4), f('icon', 2), f('label', 2),
      f('race', 1), f('unused', 1), f('broodWar', 1),
    ],
  },
  {
    file: 'sfxdata.dat',
    label: 'Sounds',
    entries: 1144,
    names: { kind: 'own-tbl', field: 'sound' },
    fields: [f('sound', 4), f('unknown1', 1), f('flags', 1), f('unknown2', 2), f('volume', 1)],
  },
  {
    file: 'portdata.dat',
    label: 'Portraits',
    entries: 220,
    names: { kind: 'own-tbl', field: 'portrait' },
    fields: [f('portrait', 4), f('smkChange', 1), f('unknown', 1)],
  },
  {
    file: 'mapdata.dat',
    label: 'Missions',
    entries: 65,
    names: { kind: 'own-tbl', field: 'mission' },
    fields: [f('mission', 4)],
  },
])

export const datLayoutOf = (fileName: string): DatLayout | undefined => DAT_LAYOUTS.find(layout => layout.file === fileName.toLowerCase())

const spanOf = (layout: DatLayout, field: DatField) => field.count ?? layout.entries - (field.first ?? 0)

export function datBytes(layout: DatLayout): number {
  return layout.fields.reduce((total, field) => total + spanOf(layout, field) * field.bytes * (field.parts ?? 1), 0)
}

/** A value per entry and field: a number, a tuple for a multi-part field, `null` where the field has none. */
export type DatValue = number | readonly number[] | null

export interface DatTable {
  readonly layout: DatLayout
  /** `columns[field][entry]`. */
  readonly columns: readonly (readonly DatValue[])[]
}

export function readDat(bytes: Uint8Array, layout: DatLayout): DatTable {
  const expected = datBytes(layout)
  if (bytes.byteLength !== expected)
    throw new RangeError(`${layout.file} is ${String(bytes.byteLength)} bytes; the Brood War layout is ${String(expected)} (a modded or extended table is not read)`)
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const read = (at: number, size: DatField['bytes']) => (size === 1 ? data.getUint8(at) : size === 2 ? data.getUint16(at, true) : data.getUint32(at, true))
  let at = 0
  const columns = layout.fields.map(field => {
    const first = field.first ?? 0
    const span = spanOf(layout, field)
    const parts = field.parts ?? 1
    const values: DatValue[] = Array.from({ length: layout.entries }, () => null)
    for (let index = 0; index < span; index += 1) {
      if (parts === 1) values[first + index] = read(at, field.bytes)
      else values[first + index] = Array.from({ length: parts }, (_, part) => read(at + part * field.bytes, field.bytes))
      at += field.bytes * parts
    }
    return values
  })
  return { layout, columns }
}
