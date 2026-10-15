/**
 * What a Diablo III scene places: its links (the scene's own appearance and its marker sets) and
 * the markers of a marker set, read from the values `SnoDecoder` decodes with the registry.
 *
 * Members have no names in the registry, so they are found by type: a scene names its appearance
 * with a DT_SNO of the `.app` group and its marker sets with an array of DT_SNO of the `.mrk`
 * group. A marker (`Marker`, 208 bytes) is its name (a 128-byte character array), its type (the
 * first DT_INT), its placement (`PRTransform`: a `Quaternion` — x, y, z, then w — and a position)
 * and the SNO it places (`SNOName`: group, then id), in the scene's frame.
 */
import type { SnoMember, SnoValue } from './decode.js'

export interface SceneLinks {
  /** The scene's own mesh, an appearance SNO id. */
  readonly appearance?: number
  readonly markerSets: readonly number[]
}

export interface SceneMarker {
  readonly name: string
  readonly type: number
  /** Quaternion x, y, z, w. */
  readonly rotation: readonly [number, number, number, number]
  readonly position: readonly [number, number, number]
  /** The SNO the marker places; its group is a group number of the registry. */
  readonly sno: { readonly group: number | null; readonly id: number }
}

const members = (value: SnoValue | undefined): readonly SnoMember[] => (value?.kind === 'structure' ? value.members : [])
const structureOf = (value: SnoValue | undefined, type: string) => members(value).find(member => member.value.kind === 'structure' && member.value.type === type)?.value

export function sceneLinks(scene: SnoValue, groups: Readonly<Record<number, string>>): SceneLinks {
  let appearance: number | undefined
  const markerSets: number[] = []
  for (const { value } of members(scene)) {
    if (value.kind === 'sno' && value.group !== null && groups[value.group] === '.app' && value.id > 0) appearance ??= value.id
    if (value.kind === 'array')
      for (const item of value.items)
        if (item.kind === 'sno' && item.group !== null && groups[item.group] === '.mrk' && item.id > 0) markerSets.push(item.id)
  }
  return { ...(appearance === undefined ? {} : { appearance }), markerSets }
}

function marker(value: SnoValue): SceneMarker | undefined {
  const fields = members(value)
  const name = fields.find(member => member.value.kind === 'text')?.value
  const type = fields.find(member => member.value.kind === 'number' && member.value.type === 'DT_INT')?.value
  const transform = structureOf(value, 'PRTransform')
  const quaternion = members(structureOf(transform, 'Quaternion')).map(member => member.value)
  const axis = quaternion.find(item => item.kind === 'vector')
  const w = quaternion.find(item => item.kind === 'number')
  const position = members(transform).find(member => member.value.kind === 'vector')?.value
  const sno = members(structureOf(value, 'SNOName')).find(member => member.value.kind === 'sno')?.value
  if (name?.kind !== 'text' || type?.kind !== 'number' || axis?.kind !== 'vector' || w?.kind !== 'number' || position?.kind !== 'vector' || sno?.kind !== 'sno')
    return undefined
  const [x = 0, y = 0, z = 0] = axis.value
  const [px = 0, py = 0, pz = 0] = position.value
  return { name: name.value, type: type.value, rotation: [x, y, z, w.value], position: [px, py, pz], sno: { group: sno.group, id: sno.id } }
}

/** The markers of a decoded marker set; a marker whose layout does not read is left out. */
export function markerSetMarkers(markerSet: SnoValue): SceneMarker[] {
  const array = members(markerSet).find(member => member.value.kind === 'array' && member.value.element === 'Marker')?.value
  return array?.kind === 'array' ? array.items.flatMap(item => marker(item) ?? []) : []
}
