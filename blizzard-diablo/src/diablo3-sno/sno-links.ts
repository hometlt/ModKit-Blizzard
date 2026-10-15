/**
 * What an SNO file names: every SNO reference in its decoded value, as a relation graph
 * (`common.view/relation-graph-source`) from the file to each SNO it uses.
 *
 * A reference is a DT_SNO (single or in an array, its group from the registry) or an SNOName (the
 * group beside the id). Effects spawn what a TriggerEvent names — a particle, a sound, a light, a
 * trail — at up to two hardpoints of the actor's appearance (HardpointLink, a bone or attach point by
 * name); those names go on the edge. An edge's role is where the reference sits: the name of the
 * item holding it (an EffectItem is named), else the last members of its path.
 */
import { createRelationGraphSource } from '@modkit/codec-kit'
import type { RelationGraphEdge, RelationGraphNode, RelationGraphSource } from '@modkit/sdk'
import type { SnoMember, SnoValue } from './decode.js'

const WRAPPERS = new Set(['SNOName', 'DT_SNONAME_HANDLE', 'DT_SNO', 'TriggerEvent', 'MsgTriggeredEvent'])

/** Past this many references the graph says it is capped (a GameBalance table names thousands). */
const MAX_EDGES = 4000

/** A name the file wrote; the editor's "- None -" placeholder is none. */
const text = (value: SnoValue): string | undefined => (value.kind === 'text' && value.value !== '' && value.value !== '- None -' ? value.value : undefined)

/** The attach points a TriggerEvent names: its HardpointLink entries' names. */
function hardpoints(event: SnoValue): string[] {
  if (event.kind !== 'structure') return []
  const links = event.members.find(member => member.value.kind === 'array' && member.value.element === 'HardpointLink')?.value
  if (links?.kind !== 'array') return []
  return links.items.flatMap(item => (item.kind === 'structure' ? item.members.flatMap(member => text(member.value) ?? []) : []))
}

export function snoLinks(
  root: SnoValue,
  self: { readonly group: string; readonly snoId: number },
  groups: Readonly<Record<number, string>>,
  snapshotId: string,
): RelationGraphSource {
  const selfId = `sno:${self.group}:${self.snoId}`
  const nodes = new Map<string, RelationGraphNode>([[selfId, { id: selfId, label: `${self.group} ${self.snoId}`, type: self.group }]])
  const edges = new Map<string, RelationGraphEdge>()
  let capped = false
  const walk = (value: SnoValue, path: readonly string[], at: readonly string[], item?: string) => {
    if (capped) return
    switch (value.kind) {
      case 'sno': {
        if (value.group === null || value.id <= 0) return
        const extension = groups[value.group] ?? `group ${value.group}`
        const id = `sno:${extension}:${value.id}`
        if (!nodes.has(id)) nodes.set(id, { id, label: `${extension} ${value.id}`, type: extension.replace(/^\./u, '') })
        // the wrappers every event reference passes through say nothing of where it sits
        const place = item === undefined ? path.filter(part => !WRAPPERS.has(part)).slice(-2).join(' › ') : `“${item}”`
        const role = [place, ...(at.length === 0 ? [] : [`at ${[...new Set(at)].join(', ')}`])].filter(part => part !== '').join(' · ')
        const key = `${id}\u0000${role}`
        if (!edges.has(key)) {
          if (edges.size >= MAX_EDGES) {
            capped = true
            return
          }
          edges.set(key, { from: selfId, to: id, ...(role === '' ? {} : { role }) })
        }
        return
      }
      case 'structure': {
        const here = value.type === 'TriggerEvent' ? hardpoints(value) : at
        // an item that names itself (an EffectItem, a marker) names what it holds; a hardpoint's own name does not
        const named = value.type === 'HardpointLink' ? undefined : value.members.map(member => text(member.value)).find(name => name !== undefined)
        for (const member of value.members) walk(member.value, [...path, memberName(member)], here, named ?? item)
        return
      }
      case 'array':
        value.items.forEach((entry, index) => walk(entry, [...path.slice(0, -1), `${value.element}[${index}]`], at, item))
        return
      default:
        return
    }
  }
  walk(root, [], [])
  return createRelationGraphSource({
    snapshotId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    ...(capped ? { completeness: 'capped' as const, reason: `the file names more than ${MAX_EDGES} references; the first ${MAX_EDGES} are shown` } : {}),
  })
}

/** A member by its name, else its type (without the offset). */
function memberName(member: SnoMember): string {
  return member.name ?? member.label.replace(/@0x[0-9a-f]+$/u, '')
}
